import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../graph/dependencies.js";
import { unpinBestEffort, unpinRecapNow } from "../graph/pinning.js";
import { emitEvent, findLastSuccessfulEvent } from "../graph/emitEvent.js";
import { buildClosureCancelMessage, POLL_DELETE_MAX_AGE_HOURS } from "../graph/nodes/pollQuestion.js";
import { cancelJobRun } from "../jobRuns.js";
import { deleteMessage, sendMessage } from "../mcp/huddleBot.js";
import { withdrawRoster } from "../roster/publishRoster.js";
import { setPollUnpinnedAt } from "../roster/rosterStore.js";
import { sendTelegramMessage } from "../telegram/telegram.js";
import type { ClosureImpactEntry } from "./closureImpact.js";

export interface ClosureForCancel {
  id: string;
  label: string | null;
}

export type CancelJobForClosureResult =
  | { ok: true; jobId: string; pollDeleted: boolean }
  | { ok: false; jobId: string; error: string; pollDeleted: boolean };

const HOUR_MS = 3600 * 1000;
/** Essais de retrait du roster quand le claim de publication est pris, et attente entre deux essais. */
export const WITHDRAW_ATTEMPTS = 3;
export const WITHDRAW_RETRY_DELAY_MS = 1000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface CancelJobForClosureOptions {
  /** Attente entre deux essais de retrait du roster — injectable pour les tests. */
  sleep?: (ms: number) => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function closureCancelReason(label: string | null): string {
  const trimmed = label?.trim();
  return trimmed ? `PUC fermé : ${trimmed}` : "PUC fermé";
}

/**
 * Arrêt d'un job en cours suite à une fermeture PUC déclarée après coup (spec 2026-09-12).
 * Ordre strict : suppression du sondage (best effort) → message WhatsApp → annulation du job
 * (TOUJOURS, même si le message a échoué : le job ne doit pas continuer) → événement → Telegram.
 * Les réservations TeamR ne sont jamais touchées.
 */
export async function cancelJobForClosure(
  deps: GraphDependencies,
  rule: BookingRule,
  job: JobRun,
  entry: ClosureImpactEntry,
  closure: ClosureForCancel,
  options: CancelJobForClosureOptions = {},
): Promise<CancelJobForClosureResult> {
  const groupJid = rule.whatsappGroupJid;

  let pollDeleted = false;
  if (job.rosterPhoto) {
    // Sondage conservé après la collecte (roster vivant) : suppression < 48 h sinon désépinglage.
    // Le roster, lui, est retiré après l'annulation du job (un tick ne doit pas le republier).
    pollDeleted = await retirePoll(deps, rule, job);
  } else if (job.pollClosedAt) {
    // Déjà supprimé à la collecte (spec 2026-10-09) : ne pas rappeler delete_message.
    pollDeleted = true;
  } else if (job.pollMsgId) {
    try {
      await deleteMessage(deps.huddleBot.client, groupJid, job.pollMsgId);
      pollDeleted = true;
    } catch {
      pollDeleted = false;
    }
  }

  const message = buildClosureCancelMessage(job.targetDate, [closure.label], pollDeleted);
  let sendError: string | undefined;
  try {
    await sendMessage(deps.huddleBot.client, groupJid, message);
  } catch (err) {
    sendError = errorMessage(err);
  }

  await cancelJobRun(deps.db, job.id, { reason: closureCancelReason(closure.label), clubClosureId: closure.id });
  await unpinRecapNow(deps, rule.name ?? rule.id, job);
  if (job.rosterPhoto) await retireLiveRoster(deps, rule, job, options.sleep ?? defaultSleep);

  const baseDetail = {
    closureId: closure.id,
    label: closure.label,
    stage: entry.stage,
    pollDeleted,
    message,
    closedTimes: entry.closedTimes,
  };
  await emitEvent(deps.db, {
    bookingRuleId: rule.id,
    jobRunId: job.id,
    type: "club-closed",
    status: sendError ? "error" : "success",
    targetDate: job.targetDate,
    detail: sendError ? { ...baseDetail, step: "send_message", error: sendError } : baseDetail,
  });

  const reason = closure.label?.trim() ? ` (${closure.label.trim()})` : "";
  await sendTelegramMessage(
    deps.telegram,
    `[${rule.id}] PUC fermé le ${job.targetDate}${reason} — job ${job.id} arrêté à l'étape ${entry.stage}, sondage supprimé : ${pollDeleted ? "oui" : "non"}${sendError ? ` — message WhatsApp en échec : ${sendError}` : ""}`,
  );

  if (sendError) return { ok: false, jobId: job.id, error: sendError, pollDeleted };
  return { ok: true, jobId: job.id, pollDeleted };
}

/**
 * Job du roster vivant : le sondage a été conservé. Moins de 48 h → suppression ; sinon (ou si elle
 * échoue) désépinglage best-effort si la copie de la règle du job épingle. `poll_unpinned_at` est écrit
 * dès qu'il n'y a plus rien à désépingler, pour que la passe sondage du tick ne le reprenne pas.
 * Renvoie true seulement si le sondage a été supprimé. Ne lève jamais.
 */
async function retirePoll(deps: GraphDependencies, rule: BookingRule, job: JobRun): Promise<boolean> {
  const ruleLabel = rule.name ?? rule.id;
  const jobRule = job.ruleSnapshot ?? rule;
  const pollJid = job.ruleSnapshot?.whatsappGroupJid ?? rule.whatsappGroupJid;
  const now = new Date();

  let pollDeleted = false;
  let unpinned = false;
  if (job.pollMsgId) {
    const pollEvent = await findLastSuccessfulEvent(deps.db, job.id, "poll").catch(() => undefined);
    const sentAt = pollEvent?.createdAt ?? null;
    if (sentAt && now.getTime() - sentAt.getTime() < POLL_DELETE_MAX_AGE_HOURS * HOUR_MS) {
      try {
        await deleteMessage(deps.huddleBot.client, pollJid, job.pollMsgId);
        pollDeleted = true;
      } catch {
        pollDeleted = false;
      }
    }
    if (!pollDeleted && jobRule.pinMessagesEnabled) {
      unpinned = await unpinBestEffort(deps, ruleLabel, pollJid, job.pollMsgId, "du sondage");
    }
  }
  // Rien à désépingler (règle sans épinglage, ou sondage sans msgId) : on le marque aussi.
  const nothingToUnpin = !pollDeleted && (!job.pollMsgId || !jobRule.pinMessagesEnabled);
  if (pollDeleted || unpinned || nothingToUnpin) {
    await setPollUnpinnedAt(deps.db, job.id, now).catch(() => {});
  }
  return pollDeleted;
}

/** Retire le roster du job déjà annulé (après `cancelJobRun`), avec ses essais. */
async function retireLiveRoster(
  deps: GraphDependencies,
  rule: BookingRule,
  job: JobRun,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const jobRule = job.ruleSnapshot ?? rule;
  const pollJid = job.ruleSnapshot?.whatsappGroupJid ?? rule.whatsappGroupJid;
  await withdrawRosterWithRetries(deps, job, rule.name ?? rule.id, jobRule.pinMessagesEnabled, pollJid, sleep);
}

async function withdrawRosterWithRetries(
  deps: GraphDependencies,
  job: JobRun,
  ruleLabel: string,
  pinEnabled: boolean,
  pollJid: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const ctx = { deps, job, ruleLabel, pinEnabled, notifyJid: job.rosterJid ?? pollJid };
  for (let attempt = 1; attempt <= WITHDRAW_ATTEMPTS; attempt += 1) {
    try {
      if (await withdrawRoster({ ...ctx, now: new Date() })) return;
    } catch (err) {
      await sendTelegramMessage(deps.telegram, `[${ruleLabel}] Retrait du roster échoué à la fermeture PUC : ${errorMessage(err)}`).catch(() => {});
      return;
    }
    if (attempt < WITHDRAW_ATTEMPTS) await sleep(WITHDRAW_RETRY_DELAY_MS);
  }
  await sendTelegramMessage(
    deps.telegram,
    `[${ruleLabel}] Roster non retiré à la fermeture PUC : publication en cours après ${WITHDRAW_ATTEMPTS} essais — à retirer à la main.`,
  ).catch(() => {});
}
