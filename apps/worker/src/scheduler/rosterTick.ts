import type { Database } from "@squash-assistant/db/client";
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { PipelineGraph } from "../graph/buildGraph.js";
import type { GraphDependencies } from "../graph/dependencies.js";
import { resolveAnnounceNotifyJid } from "../graph/nodes/announce.js";
import { loadBookingRules } from "../bookingRules.js";
import { reservedBookings } from "../graph/unbookedPlayers.js";
import { findActiveJobRunForDate } from "../jobRuns.js";
import type { McpConnection } from "../mcp/client.js";
import { unpinMessage } from "../mcp/huddleBot.js";
import { computeLiveRosters } from "../roster/finalRoster.js";
import { publishRoster, retryOrphanUnpin, withdrawRoster, type RosterPublishContext } from "../roster/publishRoster.js";
import {
  listJobsWithPinnedPoll,
  listJobsWithRoster,
  listJobsWithRosterOrphan,
  setPollUnpinnedAt,
  setRosterStoppedAt,
} from "../roster/rosterStore.js";
import { sendTelegramMessage, type TelegramConfig } from "../telegram/telegram.js";
import { RECAP_UNPIN_ABANDON_DAYS, RECAP_UNPIN_FALLBACK_MINUTES, isRecapUnpinDue, isRecapUnpinStale } from "./recapUnpin.js";
import { getJobExecutionStatus, type PipelineStage, type RuleExecutionStatus } from "./scheduler.js";
import { firstReservedSlotMinutes } from "./startReminder.js";
import { computeTargetDate } from "./weekKey.js";

// Tick à la minute du roster vivant (spec 2026-10-24-roster-desistements §4.7, CA-9, CA-10) :
// republication à chaque changement de vote, arrêt au premier créneau réservé, retrait du roster
// d'un job terminé sans réservation, puis passes orphelin et sondage. Un try/catch par job.

const PROVISIONAL_STAGES: readonly PipelineStage[] = ["awaiting-plan", "awaiting-go"];
const NO_BOOKING_STAGES: readonly PipelineStage[] = ["finished-no-plan", "finished-cancelled", "error"];

/** Jobs dont l'échec de désépinglage du sondage a déjà été signalé — un Telegram par job (perdu au redémarrage). */
const pollUnpinLoggedJobIds = new Set<string>();

export function __resetRosterTickLogForTests(): void {
  pollUnpinLoggedJobIds.clear();
}

interface TickContext {
  now: Date;
  graph: PipelineGraph;
  deps: GraphDependencies;
  liveRules: Map<string, BookingRule>;
}

interface JobView {
  status: RuleExecutionStatus;
  /** Copie de la règle prise par le job (P1-9) : groupe du sondage, épinglage. */
  copy: BookingRule;
  label: string;
}

/** État LangGraph et copie de la règle du job ; null si ni règle live ni copie (job très ancien). */
async function viewJob(tick: TickContext, job: JobRun): Promise<JobView | null> {
  const live = tick.liveRules.get(job.bookingRuleId);
  const statusRule = live ?? job.ruleSnapshot;
  if (!statusRule) return null;
  const status = await getJobExecutionStatus(statusRule, job, tick.graph);
  const copy = status.values.bookingRule ?? job.ruleSnapshot ?? statusRule;
  return { status, copy, label: live?.name ?? job.bookingRuleId };
}

/**
 * Heure de fin du roster (minutes Paris le jour du match) : premier créneau réservé d'un job
 * annoncé ou d'un job en `error` qui a un roster définitif (courts réellement pris), lu sur le
 * checkpoint quel que soit le stage ; avec un roster définitif, 23h59 à défaut de créneau lisible
 * (B1-13 c) — sauf annonce sans aucun court réservé. null : aucune réservation, pas de fin.
 */
function rosterEndMinutes(job: JobRun, status: RuleExecutionStatus): number | null {
  const groups = status.values.bookingPlanGroups ?? [];
  const failures = status.values.reservationFailures ?? [];
  const firstSlot = firstReservedSlotMinutes(groups, failures);
  const withFinal = Boolean(job.rosterFinal);
  // Annoncé sans aucun court réservé (échec total) : fin sans réservation, roster retiré.
  const announcedWithoutCourt = status.stage === "finished-announced" && reservedBookings(groups, failures).length === 0;
  if (status.stage === "finished-announced" && (!withFinal || announcedWithoutCourt)) return firstSlot;
  if (status.stage === "finished-announced" || (status.stage === "error" && withFinal)) {
    return firstSlot ?? RECAP_UNPIN_FALLBACK_MINUTES;
  }
  return null;
}

function publishContext(tick: TickContext, job: JobRun, view: JobView, notifyJid: string): RosterPublishContext {
  return { deps: tick.deps, job, ruleLabel: view.label, pinEnabled: view.copy.pinMessagesEnabled, notifyJid, now: tick.now };
}

/**
 * Fin (CA-10) : désépingle le roster courant (orphelin si échec), puis plus aucune publication. Avec
 * `withdraw` (job remplacé, date passée sans réservation, B1-13) : retrait complet (suppression si
 * moins de 48 h, sinon désépinglage) avant l'arrêt.
 */
async function stopRoster(ctx: RosterPublishContext, opts: { withdraw?: boolean } = {}): Promise<void> {
  // Claim occupé : rien n'est fait, le tick suivant retente.
  if (ctx.job.rosterMsgId && !(await withdrawRoster(ctx, { unpinOnly: !opts.withdraw }))) return;
  await setRosterStoppedAt(ctx.deps.db, ctx.job.id, ctx.now);
}

async function refreshJobRoster(tick: TickContext, job: JobRun, today: string): Promise<void> {
  const active = await findActiveJobRunForDate(tick.deps.db, job.bookingRuleId, job.targetDate);
  const view = await viewJob(tick, job);
  if (!view) return;
  const { stage } = view.status;
  const endMinutes = rosterEndMinutes(job, view.status);
  const unpublishedCtx = () => publishContext(tick, job, view, job.rosterJid ?? view.copy.whatsappGroupJid);

  // « Nouveau job » sur la même date : l'ancien roster est retiré une fois, puis arrêté (B1-13 a).
  if (active?.id !== job.id) {
    await stopRoster(unpublishedCtx(), { withdraw: true });
    return;
  }
  if (endMinutes !== null) {
    const ended = isRecapUnpinDue({ targetDate: job.targetDate, firstReservedSlotMinutes: endMinutes, cancelled: false, now: tick.now });
    if (ended) {
      await stopRoster(unpublishedCtx());
      return;
    }
  }
  // Date passée sans réservation (attente du plan ou du go, fin sans réservation) : roster retiré
  // puis arrêté, plutôt qu'épinglé jusqu'à 7 jours (P2-9, B1-13 b).
  if (job.targetDate < today) {
    await stopRoster(unpublishedCtx(), { withdraw: true });
    return;
  }

  const withBooking = endMinutes !== null;
  if (!withBooking && (NO_BOOKING_STAGES.includes(stage) || stage === "finished-announced")) {
    if (job.rosterMsgId) await withdrawRoster(unpublishedCtx());
    return;
  }
  if (!PROVISIONAL_STAGES.includes(stage) && !(withBooking && job.rosterFinal)) return;

  const live = await computeLiveRosters(tick.deps, job, view.copy, view.label);
  if (!live) return;
  const notifyJid = await resolveAnnounceNotifyJid(tick.deps, view.copy);
  await publishRoster(publishContext(tick, job, view, notifyJid), live.text, live.phase);
}

async function retryJobOrphan(tick: TickContext, job: JobRun): Promise<void> {
  const view = await viewJob(tick, job);
  if (!view) return;
  await retryOrphanUnpin(publishContext(tick, job, view, job.rosterJid ?? view.copy.whatsappGroupJid));
}

/** Passe sondage (P1-3) : désépinglé avec le roster ; `poll_unpinned_at` écrit seulement si c'est fini. */
async function unpinJobPollIfDue(tick: TickContext, job: JobRun): Promise<void> {
  const { db, huddleBot, telegram } = tick.deps;
  // Abandon : l'épinglage 7d a expiré, inutile d'appeler huddle-bot.
  if (isRecapUnpinStale(job.targetDate, tick.now)) {
    await setPollUnpinnedAt(db, job.id, tick.now);
    return;
  }
  const view = await viewJob(tick, job);
  if (!view) return;
  // Épinglage désactivé : le sondage n'a pas été épinglé, on ne le resélectionne plus (P2-13).
  if (!view.copy.pinMessagesEnabled) {
    await setPollUnpinnedAt(db, job.id, tick.now);
    return;
  }
  const due = isRecapUnpinDue({
    targetDate: job.targetDate,
    firstReservedSlotMinutes: rosterEndMinutes(job, view.status),
    cancelled: Boolean(job.cancelledAt),
    now: tick.now,
  });
  if (!due) return;
  try {
    await unpinMessage(huddleBot.client, view.copy.whatsappGroupJid, job.pollMsgId!);
  } catch (err) {
    if (pollUnpinLoggedJobIds.has(job.id)) return;
    pollUnpinLoggedJobIds.add(job.id);
    await sendTelegramMessage(
      telegram,
      `[${view.label}] Désépinglage du sondage échoué : ${(err as Error).message} — nouvel essai chaque minute.`,
    ).catch(() => {});
    return;
  }
  await setPollUnpinnedAt(db, job.id, tick.now);
}

async function forEachJob(jobs: JobRun[], pass: string, action: (job: JobRun) => Promise<void>): Promise<void> {
  for (const job of jobs) {
    try {
      await action(job);
    } catch (err) {
      console.error(`[rosterTick] ${pass} « ${job.id} » échec :`, err);
    }
  }
}

/**
 * Tick du roster (appelé par `runMinuteTick`). Rosters vivants (y compris 7 jours en arrière, pour
 * rattraper la fin d'un job dont le pod était arrêté le jour du match), puis orphelins quel que soit
 * l'état du job (C3-3), puis sondages encore épinglés, sans filtre de date ni d'état.
 */
export async function triggerRosterRefresh(
  now: Date,
  graph: PipelineGraph,
  telegram: TelegramConfig,
  db: Database,
  huddleBot: McpConnection,
  resaSquash: McpConnection,
): Promise<void> {
  const today = computeTargetDate(now, 0);
  const rosterJobs = await listJobsWithRoster(db, computeTargetDate(now, -RECAP_UNPIN_ABANDON_DAYS));
  const liveRules = new Map((await loadBookingRules(db)).map((r) => [r.id, r]));
  const tick: TickContext = { now, graph, deps: { db, huddleBot, resaSquash, telegram }, liveRules };

  await forEachJob(rosterJobs, "roster", (job) => refreshJobRoster(tick, job, today));
  await forEachJob(await listJobsWithRosterOrphan(db), "roster orphelin", (job) => retryJobOrphan(tick, job));
  await forEachJob(await listJobsWithPinnedPoll(db), "désépinglage du sondage", (job) => unpinJobPollIfDue(tick, job));
}
