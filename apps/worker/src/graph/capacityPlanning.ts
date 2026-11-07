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
