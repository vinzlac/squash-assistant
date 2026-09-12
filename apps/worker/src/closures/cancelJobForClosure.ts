import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../graph/dependencies.js";
import { emitEvent } from "../graph/emitEvent.js";
import { buildClosureCancelMessage } from "../graph/nodes/pollQuestion.js";
import { cancelJobRun } from "../jobRuns.js";
import { deleteMessage, sendMessage } from "../mcp/huddleBot.js";
import { sendTelegramMessage } from "../telegram/telegram.js";
import type { ClosureImpactEntry } from "./closureImpact.js";

export interface ClosureForCancel {
  id: string;
  label: string | null;
}

export type CancelJobForClosureResult =
  | { ok: true; jobId: string; pollDeleted: boolean }
  | { ok: false; jobId: string; error: string; pollDeleted: boolean };

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
): Promise<CancelJobForClosureResult> {
  const groupJid = rule.whatsappGroupJid;

  let pollDeleted = false;
  if (job.pollMsgId) {
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
