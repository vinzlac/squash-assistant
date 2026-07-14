import cron from "node-cron";
import { Command } from "@langchain/langgraph";
import type { BookingRule } from "../config.js";
import type { PipelineGraph } from "../graph/buildGraph.js";
import type { PipelineStateType } from "../graph/state.js";
import { sendTelegramMessage, waitForGoConfirmation, type TelegramConfig } from "../telegram/telegram.js";
import { computeTargetDate, computeWeekKey } from "./weekKey.js";

const GO_WAIT_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4h — large fenêtre pour répondre "go"
const TIMEZONE = "Europe/Paris";

interface RunnableGraphConfig {
  configurable: { thread_id: string };
}

export type PausedOn = "await-decision-window" | "await-go" | "unknown";

/**
 * Étape courante du pipeline, dérivée de l'état LangGraph — sert à l'UI pour
 * afficher le pipeline visuel (3 étapes déclenchables : sondage, collecte+plan,
 * confirmation+annonce) sans dupliquer la logique de state machine côté UI.
 */
export type PipelineStage =
  | "not-started"
  | "awaiting-decision"
  | "awaiting-go"
  | "finished-no-plan"
  | "finished-announced"
  | "finished-cancelled";

export interface RuleExecutionStatus {
  paused: boolean;
  pausedOn?: PausedOn;
  stage: PipelineStage;
  targetDate: string;
  values: Partial<PipelineStateType>;
}

function computeStage(pausedOn: PausedOn | undefined, values: Partial<PipelineStateType>): PipelineStage {
  if (!values.pollRequestId) {
    return "not-started";
  }
  if (pausedOn === "await-decision-window") {
    return "awaiting-decision";
  }
  if (pausedOn === "await-go") {
    return "awaiting-go";
  }
  if (!values.bookingPlan || values.bookingPlan.proposedBookings.length === 0) {
    return "finished-no-plan";
  }
  return values.goConfirmed ? "finished-announced" : "finished-cancelled";
}

function threadIdFor(rule: BookingRule, weekKey: string): string {
  return `${rule.id}:${weekKey}`;
}

function currentWeekConfig(rule: BookingRule): RunnableGraphConfig {
  return { configurable: { thread_id: threadIdFor(rule, computeWeekKey(new Date())) } };
}

function isInterrupted(result: unknown): boolean {
  const interrupts = (result as { __interrupt__?: unknown[] } | undefined)?.__interrupt__;
  return Boolean(interrupts && interrupts.length > 0);
}

function pausedOnFromSnapshot(snapshot: Awaited<ReturnType<PipelineGraph["getState"]>>): PausedOn | undefined {
  const interrupts = snapshot.tasks?.flatMap((task) => task.interrupts ?? []) ?? [];
  if (interrupts.length === 0) {
    return undefined;
  }
  const type = (interrupts[0]?.value as { type?: string } | undefined)?.type;
  if (type === "await-decision-window" || type === "await-go") {
    return type;
  }
  return "unknown";
}

export function scheduleBookingRules(rules: BookingRule[], graph: PipelineGraph, telegram: TelegramConfig): void {
  for (const rule of rules.filter((r) => r.enabled)) {
    // Erreur déjà reportée sur Telegram par triggerSendPoll/triggerDecision — on l'avale ici
    // pour ne pas produire un unhandled rejection (le rethrow sert au déclenchement manuel via l'API HTTP).
    cron.schedule(rule.pollCron, () => void triggerSendPoll(rule, graph, telegram).catch(() => {}), {
      timezone: TIMEZONE,
    });
    cron.schedule(rule.decisionCron, () => void triggerDecision(rule, graph, telegram).catch(() => {}), {
      timezone: TIMEZONE,
    });
  }
}

/** À appeler au démarrage : reprend l'attente du "go" si le pod a redémarré pendant la pause. */
export async function recoverPendingGoWaits(
  rules: BookingRule[],
  graph: PipelineGraph,
  telegram: TelegramConfig,
): Promise<void> {
  for (const rule of rules.filter((r) => r.enabled)) {
    const config = currentWeekConfig(rule);
    const snapshot = await graph.getState(config);
    const isPaused = snapshot.tasks?.some((task) => (task.interrupts?.length ?? 0) > 0);
    if (isPaused) {
      await sendTelegramMessage(telegram, `[${rule.id}] Reprise après redémarrage : attente du "go" relancée.`);
      void awaitGoAndResume(rule, graph, telegram, config);
    }
  }
}

/** Retourne l'état d'exécution courant (semaine en cours) d'une règle — sert à l'API de déclenchement manuel. */
export async function getRuleExecutionStatus(rule: BookingRule, graph: PipelineGraph): Promise<RuleExecutionStatus> {
  const snapshot = await graph.getState(currentWeekConfig(rule));
  const pausedOn = pausedOnFromSnapshot(snapshot);
  const values = (snapshot.values ?? {}) as Partial<PipelineStateType>;
  return {
    paused: pausedOn !== undefined,
    pausedOn,
    stage: computeStage(pausedOn, values),
    targetDate: values.targetDate ?? computeTargetDate(new Date(), rule.targetWeekdayOffset),
    values,
  };
}

export async function triggerSendPoll(rule: BookingRule, graph: PipelineGraph, telegram: TelegramConfig): Promise<void> {
  const now = new Date();
  const targetDate = computeTargetDate(now, rule.targetWeekdayOffset);
  const config = currentWeekConfig(rule);

  try {
    await graph.invoke({ bookingRule: rule, targetDate }, config);
  } catch (err) {
    await sendTelegramMessage(telegram, `[${rule.id}] Erreur SendPoll : ${(err as Error).message}`);
    throw err;
  }
}

export async function triggerDecision(rule: BookingRule, graph: PipelineGraph, telegram: TelegramConfig): Promise<void> {
  const config = currentWeekConfig(rule);

  try {
    const result = await graph.invoke(new Command({ resume: true }), config);
    if (isInterrupted(result)) {
      await awaitGoAndResume(rule, graph, telegram, config);
    }
  } catch (err) {
    await sendTelegramMessage(telegram, `[${rule.id}] Erreur CollectVotes/BookSlots : ${(err as Error).message}`);
    throw err;
  }
}

/**
 * Confirme "go" immédiatement (sans attendre de message Telegram) — utile pour un
 * déclenchement manuel de test. Refuse si le thread n'est pas réellement en pause
 * sur l'attente du "go", pour éviter d'invoquer le graphe à tort.
 */
export async function forceGoConfirmation(
  rule: BookingRule,
  graph: PipelineGraph,
  telegram: TelegramConfig,
): Promise<void> {
  const config = currentWeekConfig(rule);
  const status = await getRuleExecutionStatus(rule, graph);
  if (status.pausedOn !== "await-go") {
    throw new Error(`[${rule.id}] Pas en attente de "go" actuellement (état : ${status.pausedOn ?? "aucun"}).`);
  }

  try {
    await graph.invoke(new Command({ resume: "go" }), config);
  } catch (err) {
    await sendTelegramMessage(telegram, `[${rule.id}] Erreur Announce : ${(err as Error).message}`);
    throw err;
  }
}

async function awaitGoAndResume(
  rule: BookingRule,
  graph: PipelineGraph,
  telegram: TelegramConfig,
  config: RunnableGraphConfig,
): Promise<void> {
  const confirmed = await waitForGoConfirmation(telegram, { timeoutMs: GO_WAIT_TIMEOUT_MS });
  try {
    await graph.invoke(new Command({ resume: confirmed ? "go" : "timeout" }), config);
  } catch (err) {
    await sendTelegramMessage(telegram, `[${rule.id}] Erreur Announce : ${(err as Error).message}`);
  }
}
