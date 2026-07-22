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
