import type { BookingRule } from "../config.js";
import type { ComputeGroupBookingPlanInput } from "../planning/groupBookingPlan.js";
import { prioritizePlayers } from "./playerPriority.js";

/** Sous-ensemble de ComputeGroupBookingPlanInput dérivable d'une BookingRule — availableSlots/usedSessionIds/apiUserId/existingDailyCounts sont ajoutés dans bookSlots.ts (données d'I/O, pas de config). */
export type GroupBookingPlanParams = Omit<
  ComputeGroupBookingPlanInput,
  "availableSlots" | "usedSessionIds" | "apiUserId" | "existingDailyCounts"
>;

/**
 * Construit les paramètres du moteur local à partir d'une BookingRule, des joueurs confirmés
 * pour une heure candidate donnée (CollectVotes) et de cette heure elle-même — logique pure,
 * testable sans mock MCP. Remplace buildBookingParams.ts (params MCP plan_group_bookings).
 */
export function buildGroupBookingPlanParams(
  rule: BookingRule,
  confirmedPlayerIds: string[],
  targetDate: string,
  startTime: string,
  /** Écrase rule.preferMinPlayersPerCourt — utilisé par l'escalade min→max (ADR-014). */
  preferMinPlayersPerCourtOverride?: boolean,
  /** Prête-noms déjà mobilisés ce jour-là (voir ADR-016) — jamais reproposés comme substitut. */
  usedTodayIds: ReadonlySet<string> = new Set(),
  /** Prête-noms volontaires du sondage de la semaine (ADR-017) — prioritaires sur rule.substituteBookers. */
  volunteerSubstituteIds: string[] = [],
): GroupBookingPlanParams {
  const eligible = (id: string) => !usedTodayIds.has(id) && !confirmedPlayerIds.includes(id);
  const volunteers = volunteerSubstituteIds.filter(eligible);
  const volunteerSet = new Set(volunteers);
  const defaults = rule.substituteBookers.filter((id) => eligible(id) && !volunteerSet.has(id));
  const substitutePlayerIds = [...volunteers, ...defaults];
  return {
    groupId: rule.resaSquashGroupId,
    onDate: targetDate,
    expectedPlayerIds: prioritizePlayers(confirmedPlayerIds, rule.priorityBookers),
    substitutePlayerIds,
    slotsPerPlayer: rule.maxReservationsPerPlayer,
    startTime,
    maxCourts: rule.maxCourtsPerSlot,
    preferMinPlayersPerCourt: preferMinPlayersPerCourtOverride ?? rule.preferMinPlayersPerCourt,
    courtPriority: rule.courtPriority,
    maxDailyReservationsPerPlayer: rule.maxDailyReservationsPerPlayer,
    maxPlayersPerCourt: rule.maxPlayersPerCourt,
    availabilityWindowHours: rule.availabilityWindowHours,
  };
}
