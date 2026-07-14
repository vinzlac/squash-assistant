import cron from "node-cron";
import { Command } from "@langchain/langgraph";
import type { BookingRule } from "../config.js";
import type { PipelineGraph } from "../graph/buildGraph.js";
import { sendTelegramMessage, waitForGoConfirmation, type TelegramConfig } from "../telegram/telegram.js";
import { computeTargetDate, computeWeekKey } from "./weekKey.js";

const GO_WAIT_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4h — large fenêtre pour répondre "go"
const TIMEZONE = "Europe/Paris";

interface RunnableGraphConfig {
  configurable: { thread_id: string };
}

function threadIdFor(rule: BookingRule, weekKey: string): string {
  return `${rule.id}:${weekKey}`;
}

function isInterrupted(result: unknown): boolean {
  const interrupts = (result as { __interrupt__?: unknown[] } | undefined)?.__interrupt__;
  return Boolean(interrupts && interrupts.length > 0);
}

export function scheduleBookingRules(rules: BookingRule[], graph: PipelineGraph, telegram: TelegramConfig): void {
  for (const rule of rules.filter((r) => r.enabled)) {
    cron.schedule(rule.pollCron, () => void runSendPollTrigger(rule, graph, telegram), { timezone: TIMEZONE });
    cron.schedule(rule.decisionCron, () => void runDecisionTrigger(rule, graph, telegram), {
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
  const weekKey = computeWeekKey(new Date());
  for (const rule of rules.filter((r) => r.enabled)) {
    const config = { configurable: { thread_id: threadIdFor(rule, weekKey) } };
    const snapshot = await graph.getState(config);
    const isPaused = snapshot.tasks?.some((task) => (task.interrupts?.length ?? 0) > 0);
    if (isPaused) {
      await sendTelegramMessage(telegram, `[${rule.id}] Reprise après redémarrage : attente du "go" relancée.`);
      void awaitGoAndResume(rule, graph, telegram, config);
    }
  }
}

async function runSendPollTrigger(rule: BookingRule, graph: PipelineGraph, telegram: TelegramConfig): Promise<void> {
  const now = new Date();
  const weekKey = computeWeekKey(now);
  const targetDate = computeTargetDate(now, rule.targetWeekdayOffset);
  const config: RunnableGraphConfig = { configurable: { thread_id: threadIdFor(rule, weekKey) } };

  try {
    await graph.invoke({ bookingRule: rule, targetDate }, config);
  } catch (err) {
    await sendTelegramMessage(telegram, `[${rule.id}] Erreur SendPoll : ${(err as Error).message}`);
  }
}

async function runDecisionTrigger(rule: BookingRule, graph: PipelineGraph, telegram: TelegramConfig): Promise<void> {
  const weekKey = computeWeekKey(new Date());
  const config: RunnableGraphConfig = { configurable: { thread_id: threadIdFor(rule, weekKey) } };

  try {
    const result = await graph.invoke(new Command({ resume: true }), config);
    if (isInterrupted(result)) {
      await awaitGoAndResume(rule, graph, telegram, config);
    }
  } catch (err) {
    await sendTelegramMessage(telegram, `[${rule.id}] Erreur CollectVotes/BookSlots : ${(err as Error).message}`);
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
