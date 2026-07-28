import type { BookingRule } from "../config.js";
import type { PlanGroupBookingsParams } from "../mcp/resaSquash.js";
import { prioritizePlayers } from "./playerPriority.js";

/**
 * Construit les paramètres d'appel plan_group_bookings à partir d'une
 * BookingRule, des joueurs confirmés pour une heure candidate donnée
 * (CollectVotes) et de cette heure elle-même — logique pure, testable sans
 * mock MCP. Un appel par heure candidate ayant des joueurs confirmés (voir
 * bookSlots.ts, ADR-013) ; minPlayersPerCourt/maxPlayersPerCourt restent des
 * seuils locaux à squash-assistant, pas de paramètre équivalent côté
 * resa-squash (déclenchent "pas assez de joueurs" avant l'appel MCP).
 */
export function buildPlanGroupBookingsParams(
  rule: BookingRule,
  confirmedPlayerIds: string[],
  targetDate: string,
  startTime: string,
  /** Écrase rule.preferMinPlayersPerCourt — utilisé par l'escalade min→max quand la capacité manque (voir capacityPlanning.ts, ADR-014). */
  preferMinPlayersPerCourtOverride?: boolean,
  /**
   * Prête-noms déjà mobilisés ce jour-là (joueurs confirmés sur une autre heure candidate, ou
   * prête-noms déjà consommés par un appel précédent du même jour) — jamais reproposés comme
   * substitut. Voir ADR-016.
   */
  usedTodayIds: ReadonlySet<string> = new Set(),
  /** Prête-noms volontaires du sondage de la semaine (ADR-017) — prioritaires sur rule.substituteBookers. */
  volunteerSubstituteIds: string[] = [],
  /**
   * Courts déjà occupés (par le plan d'une heure candidate précédente dans la
   * même exécution de BookSlots) sur la plage horaire de cette heure — déplacés
   * en fin de `courtPriority` plutôt que retirés, pour laisser resa-squash les
   * choisir malgré tout si aucun autre court n'est disponible (mieux qu'un plan
   * vide). N'empêche pas un conflit à 100% (resa-squash ne connaît pas ce plan
   * concurrent, encore en dry-run) — le filet de sécurité reste la détection de
   * conflit a posteriori dans bookSlots.ts.
   */
  busyCourts: readonly number[] = [],
): PlanGroupBookingsParams {
  const eligible = (id: string) => !usedTodayIds.has(id) && !confirmedPlayerIds.includes(id);
  const volunteers = volunteerSubstituteIds.filter(eligible);
  const volunteerSet = new Set(volunteers);
  const defaults = rule.substituteBookers.filter((id) => eligible(id) && !volunteerSet.has(id));
  const substitutePlayerIds = [...volunteers, ...defaults];
  const busySet = new Set(busyCourts);
  const courtPriority = rule.courtPriority
    ? [...rule.courtPriority.filter((c) => !busySet.has(c)), ...rule.courtPriority.filter((c) => busySet.has(c))]
    : rule.courtPriority;
  return {
    groupId: rule.resaSquashGroupId,
    onDate: targetDate,
    expectedPlayerIds: prioritizePlayers(confirmedPlayerIds, rule.priorityBookers),
    substitutePlayerIds,
    slotsPerPlayer: rule.maxReservationsPerPlayer,
    dryRun: true,
    startTime,
    maxCourts: rule.maxCourtsPerSlot,
    preferMinPlayersPerCourt: preferMinPlayersPerCourtOverride ?? rule.preferMinPlayersPerCourt,
    courtPriority,
    maxDailyReservationsPerPlayer: rule.maxDailyReservationsPerPlayer,
  };
}
