import type { GroupBookingPlan } from "../mcp/resaSquash.js";

/**
 * Parse une heure format TeamR ("18H45") en minutes depuis minuit. `null` si
 * le format ne correspond pas — jamais censé arriver sur des heures qui
 * viennent de resa-squash ou de candidateStartTimes (déjà validées), mais
 * on ne veut pas planter le pipeline sur un format inattendu.
 */
export function parseTeamrTime(time: string): number | null {
  const match = /^(\d{1,2})H(\d{2})$/i.exec(time.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

/**
 * Nombre de joueurs attendus mais non casés dans ce plan : réservations
 * attendues (paires × créneaux/joueur visés) moins réservations réellement
 * proposées par resa-squash. 0 si le plan a atteint son objectif ou si
 * `pairCount`/`slotsPerPlayer` sont nuls (cas "pas assez de joueurs", déjà
 * traité en amont, cf. bookSlots.ts).
 */
export function computeShortfall(plan: GroupBookingPlan): number {
  const expected = plan.meta.pairCount * plan.meta.slotsPerPlayer;
  return Math.max(0, expected - plan.proposedBookings.length);
}

/**
 * Sépare les réservations proposées par resa-squash selon qu'elles tombent
 * dans la fenêtre acceptée (heure votée + availabilityWindowHours) ou non.
 * resa-squash cherche déjà sur toute la journée disponible et peut avancer
 * loin dans le temps si les courts manquent (cf. ADR-014) — ce filtre est
 * entièrement local à squash-assistant, aucune évolution d'API resa-squash.
 */
export function splitByAvailabilityWindow(
  plan: GroupBookingPlan,
  startTime: string,
  availabilityWindowHours: number,
): { outOfWindowSessionIds: string[] } {
  const startMinutes = parseTeamrTime(startTime);
  if (startMinutes == null) return { outOfWindowSessionIds: [] };

  const cutoffMinutes = startMinutes + availabilityWindowHours * 60;
  const outOfWindowSessionIds = plan.proposedBookings
    .filter((b) => {
      const slotMinutes = parseTeamrTime(b.slotTime);
      return slotMinutes != null && slotMinutes > cutoffMinutes;
    })
    .map((b) => b.sessionId);

  return { outOfWindowSessionIds };
}

/**
 * Nombre de joueurs "casés mais hors fenêtre" (donc pas réservés) parmi les
 * `outOfWindowSessionIds` d'un plan — chaque réservation hors fenêtre porte 1
 * ou 2 joueurs (userId + partnerId optionnel).
 */
export function countPlayersInSessions(plan: GroupBookingPlan, sessionIds: string[]): number {
  const idSet = new Set(sessionIds);
  let count = 0;
  for (const b of plan.proposedBookings) {
    if (!idSet.has(b.sessionId)) continue;
    count += b.partnerId ? 2 : 1;
  }
  return count;
}

/** Occupation d'un court sur une plage horaire donnée (minutes depuis minuit). */
export interface CourtInterval {
  court: number;
  startMinutes: number;
  endMinutes: number;
}

function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Convertit les réservations proposées par un plan en intervalles d'occupation
 * de court — utilisé pour détecter les conflits entre le plan d'une heure
 * candidate et ceux déjà calculés pour les heures précédentes dans la même
 * exécution de BookSlots (cf. bookSlots.ts : chaque heure candidate donne lieu
 * à un appel `plan_group_bookings` indépendant, sans connaissance des autres
 * heures). `excludeSessionIds` sert à ne pas compter comme
 * "occupées" les réservations qui ne seront de toute façon jamais posées
 * (hors fenêtre, ou déjà écartées pour conflit).
 */
export function courtIntervalsFromPlan(
  plan: GroupBookingPlan,
  excludeSessionIds: ReadonlySet<string> = new Set(),
): CourtInterval[] {
  const intervals: CourtInterval[] = [];
  for (const b of plan.proposedBookings) {
    if (excludeSessionIds.has(b.sessionId)) continue;
    const startMinutes = parseTeamrTime(b.slotTime);
    const endMinutes = parseTeamrTime(b.slotEndTime);
    if (startMinutes == null || endMinutes == null) continue;
    intervals.push({ court: b.court, startMinutes, endMinutes });
  }
  return intervals;
}

/**
 * Réservations proposées par ce plan qui chevauchent (même court, plages
 * horaires qui se recoupent) une occupation déjà connue — signe d'un vrai
 * double-booking, puisque deux appels `plan_group_bookings` distincts
 * peuvent chacun proposer le même court sans se voir l'un l'autre.
 */
export function conflictingSessionIds(plan: GroupBookingPlan, occupied: readonly CourtInterval[]): string[] {
  const conflicts: string[] = [];
  for (const b of plan.proposedBookings) {
    const startMinutes = parseTeamrTime(b.slotTime);
    const endMinutes = parseTeamrTime(b.slotEndTime);
    if (startMinutes == null || endMinutes == null) continue;
    const hasConflict = occupied.some(
      (o) => o.court === b.court && intervalsOverlap(startMinutes, endMinutes, o.startMinutes, o.endMinutes),
    );
    if (hasConflict) conflicts.push(b.sessionId);
  }
  return conflicts;
}

/**
 * Numéros de court déjà occupés (par un plan d'une heure candidate précédente)
 * sur une plage horaire donnée — sert à déprioriser ces courts avant même
 * d'appeler `plan_group_bookings` pour l'heure candidate suivante, plutôt que
 * de découvrir le conflit après coup.
 */
export function busyCourtsDuring(
  occupied: readonly CourtInterval[],
  startMinutes: number,
  endMinutes: number,
): number[] {
  const courts = new Set<number>();
  for (const o of occupied) {
    if (intervalsOverlap(startMinutes, endMinutes, o.startMinutes, o.endMinutes)) courts.add(o.court);
  }
  return [...courts];
}
