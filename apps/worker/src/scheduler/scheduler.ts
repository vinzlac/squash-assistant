import cron from "node-cron";
import { Command } from "@langchain/langgraph";
import type { Database } from "@squash-assistant/db/client";
import type { JobRun } from "@squash-assistant/db/schema";
import type { BookingRule } from "../config.js";
import type { PipelineGraph } from "../graph/buildGraph.js";
import type { PipelineStateType } from "../graph/state.js";
import { createJobRun, findActiveJobRunForDate, listJobRuns, threadIdForJob } from "../jobRuns.js";
import { sendTelegramMessage, waitForGoConfirmation, type TelegramConfig } from "../telegram/telegram.js";
import { computeTargetDate } from "./weekKey.js";

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
  | "error"
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

/**
 * `pausedOn === "unknown"` signifie qu'un nœud a été interrompu par une
 * exception (pas un `interrupt()` connu) et reste en attente de relance —
 * ne JAMAIS le confondre avec "finished-no-plan" (bookSlots a fini son
 * exécution et a légitimement décidé de ne rien proposer) : cette confusion
 * causait un job planté affiché comme terminé avec succès dans l'UI.
 */
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
  if (pausedOn === "unknown") {
    return "error";
  }
  if (!values.bookingPlan || values.bookingPlan.proposedBookings.length === 0) {
    return "finished-no-plan";
  }
  return values.goConfirmed ? "finished-announced" : "finished-cancelled";
}

function jobConfig(bookingRuleId: string, jobId: string): RunnableGraphConfig {
  return { configurable: { thread_id: threadIdForJob(bookingRuleId, jobId) } };
}

function isInterrupted(result: unknown): boolean {
  const interrupts = (result as { __interrupt__?: unknown[] } | undefined)?.__interrupt__;
  return Boolean(interrupts && interrupts.length > 0);
}

/**
 * Dérivé de `snapshot.next` (prochains nœuds à exécuter), pas de
 * `snapshot.tasks[].interrupts` : ce dernier ne reconstruit pas fiablement le
 * payload d'interrupt avec @langchain/langgraph-checkpoint-redis — les
 * données brutes existent bien dans Redis (vérifié manuellement), mais une
 * incohérence checkpoint_ns ("" vs "__empty__") entre le checkpoint et ses
 * checkpoint_write empêche leur jointure côté package. `next` reste fiable
 * et suffit à nos deux seuls points de pause (les nœuds barrière).
 */
function pausedOnFromSnapshot(snapshot: Awaited<ReturnType<PipelineGraph["getState"]>>): PausedOn | undefined {
  const next = snapshot.next ?? [];
  if (next.includes("waitForDecisionWindow")) {
    return "await-decision-window";
  }
  if (next.includes("waitForGoConfirmation")) {
    return "await-go";
  }
  return next.length > 0 ? "unknown" : undefined;
}

/**
 * Un job = une exécution du pipeline pour une date cible donnée (cf.
 * packages/db/src/schema.ts, jobRuns). Une règle peut avoir plusieurs jobs en
 * parallèle (tests manuels multiples, ou un job cron + des jobs manuels côte
 * à côte) — le cron crée/retrouve son propre job par date cible pour rester
 * idempotent si pollCron/decisionCron se déclenchent plusieurs fois le même jour.
 */
export function scheduleBookingRules(
  rules: BookingRule[],
  graph: PipelineGraph,
  telegram: TelegramConfig,
  db: Database,
): void {
  for (const rule of rules.filter((r) => r.enabled)) {
    // Erreur déjà reportée sur Telegram par triggerSendPoll/triggerDecision — on l'avale ici
    // pour ne pas produire un unhandled rejection (le rethrow sert au déclenchement manuel via l'API HTTP).
    cron.schedule(rule.pollCron, () => void triggerCronSendPoll(rule, graph, telegram, db).catch(() => {}), {
      timezone: TIMEZONE,
    });
    cron.schedule(rule.decisionCron, () => void triggerCronDecision(rule, graph, telegram, db).catch(() => {}), {
      timezone: TIMEZONE,
    });
  }
}

async function triggerCronSendPoll(
  rule: BookingRule,
  graph: PipelineGraph,
  telegram: TelegramConfig,
  db: Database,
): Promise<void> {
  const targetDate = computeTargetDate(new Date(), rule.targetWeekdayOffset);
  const existing = await findActiveJobRunForDate(db, rule.id, targetDate);
  if (existing) {
    return; // déjà un job pour cette date (pollCron déclenché deux fois) — idempotent, on ne renvoie pas de 2e sondage.
  }
  const job = await createJobRun(db, rule.id, targetDate, rule.sessionStartTime);
  await triggerSendPoll(rule, job, graph, telegram);
}

async function triggerCronDecision(
  rule: BookingRule,
  graph: PipelineGraph,
  telegram: TelegramConfig,
  db: Database,
): Promise<void> {
  const targetDate = computeTargetDate(new Date(), rule.targetWeekdayOffset);
  const job = await findActiveJobRunForDate(db, rule.id, targetDate);
  if (!job) {
    await sendTelegramMessage(telegram, `[${rule.id}] Aucun job actif pour le ${targetDate} — decisionCron ignoré.`);
    return;
  }
  await triggerDecision(rule, job, graph, telegram);
}

/** À appeler au démarrage : reprend l'attente du "go" pour tout job resté en pause pendant un redémarrage du pod. */
export async function recoverPendingGoWaits(
  rules: BookingRule[],
  graph: PipelineGraph,
  telegram: TelegramConfig,
  db: Database,
): Promise<void> {
  for (const rule of rules.filter((r) => r.enabled)) {
    const jobs = await listJobRuns(db, rule.id);
    for (const job of jobs) {
      if (job.cancelledAt) continue;
      const config = jobConfig(rule.id, job.id);
      const snapshot = await graph.getState(config);
      if (pausedOnFromSnapshot(snapshot) === "await-go") {
        await sendTelegramMessage(
          telegram,
          `[${rule.id}] Reprise après redémarrage : attente du "go" relancée (job du ${job.targetDate}).`,
        );
        void awaitGoAndResume(rule, job, graph, telegram, config);
      }
    }
  }
}

/** Retourne l'état d'exécution courant d'un job donné — sert à l'API de déclenchement manuel. */
export async function getJobExecutionStatus(
  rule: BookingRule,
  job: JobRun,
  graph: PipelineGraph,
): Promise<RuleExecutionStatus> {
  const snapshot = await graph.getState(jobConfig(rule.id, job.id));
  const pausedOn = pausedOnFromSnapshot(snapshot);
  const values = (snapshot.values ?? {}) as Partial<PipelineStateType>;
  return {
    paused: pausedOn !== undefined,
    pausedOn,
    stage: computeStage(pausedOn, values),
    targetDate: values.targetDate ?? job.targetDate,
    values,
  };
}

/**
 * Refuse d'invoquer si le sondage a déjà été envoyé pour ce job (thread pas
 * "not-started") — protège contre un double déclenchement (cron + manuel,
 * double-clic) qui ferait avancer le pipeline sans action explicite de
 * l'utilisateur en mode manuel.
 */
export async function triggerSendPoll(
  rule: BookingRule,
  job: JobRun,
  graph: PipelineGraph,
  telegram: TelegramConfig,
): Promise<void> {
  const config = jobConfig(rule.id, job.id);

  const status = await getJobExecutionStatus(rule, job, graph);
  if (status.stage !== "not-started") {
    throw new Error(`[${rule.id}] Sondage déjà envoyé pour ce job (état : ${status.stage}).`);
  }

  // sessionStartTime peut avoir été modifié sur le job (mode manuel, avant l'envoi du
  // sondage) sans toucher la règle elle-même — cf. updateJobRunSchedule/handleEditJob.
  const effectiveRule: BookingRule = { ...rule, sessionStartTime: job.sessionStartTime ?? rule.sessionStartTime };

  try {
    await graph.invoke({ bookingRule: effectiveRule, jobRunId: job.id, targetDate: job.targetDate }, config);
  } catch (err) {
    await sendTelegramMessage(telegram, `[${rule.id}] Erreur SendPoll : ${(err as Error).message}`);
    throw err;
  }
}

/** Même protection que triggerSendPoll : refuse si le thread n'attend pas la collecte des votes. */
export async function triggerDecision(
  rule: BookingRule,
  job: JobRun,
  graph: PipelineGraph,
  telegram: TelegramConfig,
): Promise<void> {
  const config = jobConfig(rule.id, job.id);

  const status = await getJobExecutionStatus(rule, job, graph);
  if (status.pausedOn !== "await-decision-window") {
    throw new Error(
      `[${rule.id}] Pas en attente de collecte des votes actuellement (état : ${status.pausedOn ?? status.stage}).`,
    );
  }

  try {
    const result = await graph.invoke(new Command({ resume: true }), config);
    if (isInterrupted(result)) {
      await awaitGoAndResume(rule, job, graph, telegram, config);
    }
  } catch (err) {
    await sendTelegramMessage(telegram, `[${rule.id}] Erreur CollectVotes/BookSlots : ${(err as Error).message}`);
    throw err;
  }
}

/**
 * Relance un job planté (`stage === "error"`, un nœud a levé une exception).
 * `graph.invoke(null, config)` reprend depuis le dernier checkpoint (pas
 * `Command({resume})`, réservé à la reprise d'un `interrupt()` explicite —
 * ici il n'y en a pas, le nœud a juste échoué en cours d'exécution).
 */
export async function triggerRetry(
  rule: BookingRule,
  job: JobRun,
  graph: PipelineGraph,
  telegram: TelegramConfig,
): Promise<void> {
  const config = jobConfig(rule.id, job.id);
  const status = await getJobExecutionStatus(rule, job, graph);
  if (status.stage !== "error") {
    throw new Error(`[${rule.id}] Rien à relancer (état : ${status.stage}).`);
  }

  try {
    const result = await graph.invoke(null, config);
    if (isInterrupted(result)) {
      await awaitGoAndResume(rule, job, graph, telegram, config);
    }
  } catch (err) {
    await sendTelegramMessage(telegram, `[${rule.id}] Erreur (relance) : ${(err as Error).message}`);
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
  job: JobRun,
  graph: PipelineGraph,
  telegram: TelegramConfig,
): Promise<void> {
  const config = jobConfig(rule.id, job.id);
  const status = await getJobExecutionStatus(rule, job, graph);
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
  job: JobRun,
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
