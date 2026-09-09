import { Annotation } from "@langchain/langgraph";
import type { BookingRule } from "../config.js";
import type { GroupBookingPlan } from "../mcp/resaSquash.js";

/** Le plan de réservation pour une heure candidate donnée (calculé localement par computeGroupBookingPlan, un plan par heure — voir ADR-013, ADR-018). */
export interface BookingPlanGroup {
  startTime: string;
  plan: GroupBookingPlan;
  /** sessionId des proposedBookings hors de la fenêtre acceptée (startTime + availabilityWindowHours) — affichés mais jamais réservés. Voir ADR-014. */
  outOfWindowSessionIds: string[];
}

/** Ligne du plan refusée par resa-squash/TeamR à la réservation réelle (étape 4) — conservée pour l'annonce, la synthèse, le rappel J+1 et l'UI (ADR-027). */
export interface ReservationFailure {
  sessionId: string;
  court: number;
  slotTime: string;
  slotEndTime: string;
  userId: string;
  partnerId: string | null;
  /** Code de refus resa-squash (`PLAYER_BOOKING_LIMIT_REACHED`, `SLOT_ALREADY_BOOKED`…), null si inconnu. */
  reason: string | null;
  /** Motif lisible pour les joueurs (message TeamR si fourni). */
  message: string;
  /** Texte brut de l'erreur — canal organisateur (Telegram) et DB uniquement. */
  rawError: string;
}

export const PipelineState = Annotation.Root({
  bookingRule: Annotation<BookingRule>(),
  jobRunId: Annotation<string>(),
  targetDate: Annotation<string>(),
  pollRequestId: Annotation<string | undefined>(),
  clubClosed: Annotation<boolean | undefined>(),
  confirmedPlayerIdsByTime: Annotation<Record<string, string[]>>(),
  /** Prête-noms volontaires cette semaine (option de sondage dédiée, ADR-017), prioritaires sur BookingRule.substituteBookers. */
  volunteerSubstituteIds: Annotation<string[]>(),
  bookingPlanGroups: Annotation<BookingPlanGroup[] | undefined>(),
  goConfirmed: Annotation<boolean>(),
  /** true (défaut) = ne réserve jamais réellement (reserve_slot jamais appelé) ; false = réservation réelle demandée explicitement à la confirmation "go" (case décochée dans l'UI). Voir waitForGoConfirmation.ts, announce.ts. */
  dryRun: Annotation<boolean>(),
  announceMessage: Annotation<string | undefined>(),
  /** Refus de réservation réelle à l'étape 4 (vide/undefined = tout réservé, ou dry-run). Voir ADR-027. */
  reservationFailures: Annotation<ReservationFailure[] | undefined>(),
});

export type PipelineStateType = typeof PipelineState.State;
