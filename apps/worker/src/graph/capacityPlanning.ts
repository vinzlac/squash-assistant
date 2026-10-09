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
 * Nombre de **rounds** (réservations de 45 min) manquants dans ce plan : rounds visés
 * (`pairCount × slotsPerPlayer`, soit la somme des rounds visés par groupe d'après les
 * préférences de temps de jeu dans le cas courant — cf. groupBookingPlan.ts) moins
 * réservations proposées. Sert uniquement à décider l'escalade min→max (planJob.ts) ;
 * les alertes destinées aux humains comptent des joueurs (unbookedPlayers.ts). 0 si le
 * plan a atteint son objectif ou si `pairCount`/`slotsPerPlayer` sont nuls.
 */
export function computeShortfall(plan: GroupBookingPlan): number {
  // Arrondi : slotsPerPlayer peut être fractionnaire (somme des rounds / pairCount, cf.
  // groupBookingPlan.ts) et 7 × (29 / 7) vaut 29.000000000000004 — sans arrondi, un écart
  // flottant suffirait à déclencher une escalade.
  const expected = Math.round(plan.meta.pairCount * plan.meta.slotsPerPlayer);
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
