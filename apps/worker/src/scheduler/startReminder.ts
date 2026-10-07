import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import { parseTeamrTime } from "../graph/capacityPlanning.js";
import { reservedBookings, resolveConfirmationNotifyJid } from "../graph/nodes/announce.js";
import type { BookingPlanGroup, ReservationFailure } from "../graph/state.js";
import type { RuleExecutionStatus } from "./scheduler.js";
import { computeTargetDate } from "./weekKey.js";

/**
 * Rappel WhatsApp avant le match (spec 2026-10-05, ADR-036). Toutes les heures sont des
 * minutes depuis minuit, heure murale de Paris, le jour de la date cible — jamais une Date
 * construite par heuristique de fuseau (fausse après le passage à l'heure d'hiver).
 */
export const START_REMINDER_JITTER_HALF_MINUTES = 10;

/** Mise en production de la fonctionnalité : un job créé avant n'a jamais eu de rappel (étape 6 « — », pas « non envoyé »). */
export const START_REMINDER_SINCE = new Date("2026-10-06T00:00:00Z");

export const START_REMINDER_REASONS = {
  notEnabled: "Non activé pour cette règle",
  sameDayDecision: "décision le jour du match",
  cancelled: "job annulé",
  notActiveJob: "pas le job actif de cette date",
  awaitingAnnounce: "En attente de l'annonce (étape 4)",
  notAnnounced: "job non annoncé",
  noReservedSlot: "aucun créneau réservé",
  dryRunToPollGroup: "dry-run vers le groupe d'origine",
} as const;

export type StartReminderState = "disabled" | "skipped" | "waiting" | "due" | "sent" | "missed";

export interface StartReminderEvaluation {
  state: StartReminderState;
  /** Heure d'envoi prévue, ex. « 16h45 » (Paris). */
  plannedAt?: string;
  reason?: string;
}

export type StartReminderRule = Pick<
  BookingRule,
  | "enabled"
  | "startReminderEnabled"
  | "startReminderMinutesBefore"
  | "decisionDaysBefore"
  | "whatsappGroupJid"
  | "confirmationNotifyWhatsappGroupJid"
>;

export type StartReminderJob = Pick<JobRun, "id" | "targetDate" | "cancelledAt" | "createdAt" | "startReminderSentAt">;

export interface StartReminderInput {
  /** Règle live (réglages opérationnels). */
  rule: StartReminderRule;
  job: StartReminderJob;
  /** Ce job est-il celui que retient `findActiveJobRunForDate` pour sa date ? */
  isActiveJobForDate: boolean;
  status: Pick<RuleExecutionStatus, "stage" | "values">;
  now: Date;
}

export function parisMinutesNow(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return hour * 60 + minute;
}

export function firstReservedSlotMinutes(groups: BookingPlanGroup[], failures: ReservationFailure[]): number | null {
  const minutes = reservedBookings(groups, failures)
    .map((b) => parseTeamrTime(b.slotTime))
    .filter((m): m is number => m !== null);
  return minutes.length > 0 ? Math.min(...minutes) : null;
}

/** Décalage stable dans [−10, +10) min, dérivé de l'id du job (FNV-1a 32 bits) — rien à stocker. */
export function startReminderOffsetMinutes(jobId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < jobId.length; i++) {
    hash ^= jobId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const width = START_REMINDER_JITTER_HALF_MINUTES * 2;
  return (hash % width) - START_REMINDER_JITTER_HALF_MINUTES;
}

export function formatParisMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

/** Premier état applicable, dans l'ordre du tableau « États du rappel et priorité » de la spec. */
export function evaluateStartReminder({ rule, job, isActiveJobForDate, status, now }: StartReminderInput): StartReminderEvaluation {
  if (job.startReminderSentAt) return { state: "sent" };
  if (!rule.enabled || !rule.startReminderEnabled) return { state: "disabled", reason: START_REMINDER_REASONS.notEnabled };
  if (job.createdAt < START_REMINDER_SINCE) return { state: "disabled" };
  if (rule.decisionDaysBefore === 0) return { state: "skipped", reason: START_REMINDER_REASONS.sameDayDecision };
  if (job.cancelledAt) return { state: "skipped", reason: START_REMINDER_REASONS.cancelled };
  if (!isActiveJobForDate) return { state: "skipped", reason: START_REMINDER_REASONS.notActiveJob };
  const today = computeTargetDate(now, 0);
  if (status.stage !== "finished-announced") {
    // Match à venir : le job peut encore être annoncé (comme l'étape 5, « en attente de l'annonce »).
    return job.targetDate > today
      ? { state: "waiting", reason: START_REMINDER_REASONS.awaitingAnnounce }
      : { state: "skipped", reason: START_REMINDER_REASONS.notAnnounced };
  }

  const firstSlot = firstReservedSlotMinutes(status.values.bookingPlanGroups ?? [], status.values.reservationFailures ?? []);
  if (firstSlot === null) return { state: "skipped", reason: START_REMINDER_REASONS.noReservedSlot };

  const realBooking = status.values.dryRun === false;
  if (!realBooking && resolveConfirmationNotifyJid(rule) === rule.whatsappGroupJid) {
    return { state: "skipped", reason: START_REMINDER_REASONS.dryRunToPollGroup };
  }

  const plannedMinutes = firstSlot - rule.startReminderMinutesBefore + startReminderOffsetMinutes(job.id);
  const plannedAt = formatParisMinutes(Math.max(0, plannedMinutes));
  const nowMinutes = parisMinutesNow(now);

  if (job.targetDate < today || (job.targetDate === today && nowMinutes >= firstSlot)) {
    return { state: "missed", plannedAt };
  }
  if (job.targetDate > today || nowMinutes < plannedMinutes) {
    return { state: "waiting", plannedAt };
  }
  return { state: "due", plannedAt };
}
