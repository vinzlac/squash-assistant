import type { BookingPlanGroup, ReservationFailure } from "./state.js";

/**
 * Lignes du plan **réellement réservées** : proposées, dans la fenêtre acceptée (ADR-014), et
 * non refusées par resa-squash/TeamR à l'étape 4. Seule source pour l'annonce, les QR, la
 * synthèse et le rappel J+1 — un court refusé ne doit jamais être présenté comme pris.
 * Avant l'étape 4 (aucun refus), ce sont les lignes du plan dans la fenêtre.
 */
export function reservedBookings(
  bookingPlanGroups: BookingPlanGroup[],
  reservationFailures: ReservationFailure[] = [],
): BookingPlanGroup["plan"]["proposedBookings"] {
  const failed = new Set(reservationFailures.map((f) => f.sessionId));
  return bookingPlanGroups.flatMap((g) =>
    g.plan.proposedBookings.filter((b) => !g.outOfWindowSessionIds.includes(b.sessionId) && !failed.has(b.sessionId)),
  );
}

/**
 * Joueurs membres d'un groupe de court ayant au moins une session réellement prise (rotateurs et
 * retardataires fusionnés compris). `null` pour un ancien checkpoint sans `courtGroups`.
 */
function bookedPlayerIds(
  bookingPlanGroups: BookingPlanGroup[],
  reservationFailures: ReservationFailure[],
): Set<string> | null {
  if (bookingPlanGroups.some((g) => g.plan.meta.courtGroups === undefined)) return null;
  const reserved = new Set(reservedBookings(bookingPlanGroups, reservationFailures).map((b) => b.sessionId));
  const booked = new Set<string>();
  for (const g of bookingPlanGroups) {
    for (const courtGroup of g.plan.meta.courtGroups ?? []) {
      if (!courtGroup.sessionIds.some((id) => reserved.has(id))) continue;
      for (const member of courtGroup.members) booked.add(member);
    }
  }
  return booked;
}

/**
 * Joueurs confirmés (votes) sans aucun créneau réservé — compteur « ⚠️ N joueur(s)… » de l'annonce
 * (spec 2026-10-09 §4.2). Un joueur compte comme réservé dès qu'un des groupes de court dont il est
 * membre (rotateurs compris) a au moins une session réellement prise. Un round manquant d'un groupe
 * qui joue ne compte pas. Ancien checkpoint sans `courtGroups` : 0 (ligne omise).
 */
export function countUnbookedConfirmedPlayers(
  bookingPlanGroups: BookingPlanGroup[],
  confirmedPlayerIdsByTime: Record<string, string[]>,
  reservationFailures: ReservationFailure[] = [],
): number {
  const booked = bookedPlayerIds(bookingPlanGroups, reservationFailures);
  if (!booked) return 0;
  const confirmed = new Set(Object.values(confirmedPlayerIdsByTime).flat());
  return [...confirmed].filter((id) => !booked.has(id)).length;
}

/**
 * Même compte, ventilé par heure votée — alerte Telegram de l'étape 3 (bookSlots.ts) et détail
 * par heure de l'UI. Ancien checkpoint sans `courtGroups` : `{}` (aucune alerte).
 */
export function countUnbookedConfirmedPlayersByTime(
  bookingPlanGroups: BookingPlanGroup[],
  confirmedPlayerIdsByTime: Record<string, string[]>,
  reservationFailures: ReservationFailure[] = [],
): Record<string, number> {
  const booked = bookedPlayerIds(bookingPlanGroups, reservationFailures);
  if (!booked) return {};
  return Object.fromEntries(
    Object.entries(confirmedPlayerIdsByTime).map(([time, ids]) => [
      time,
      new Set(ids.filter((id) => !booked.has(id))).size,
    ]),
  );
}
