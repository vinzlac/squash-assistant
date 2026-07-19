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
): PlanGroupBookingsParams {
  return {
    groupId: rule.resaSquashGroupId,
    onDate: targetDate,
    expectedPlayerIds: prioritizePlayers(confirmedPlayerIds, rule.priorityBookers),
    slotsPerPlayer: rule.maxReservationsPerPlayer,
    dryRun: true,
    startTime,
    maxCourts: rule.maxCourtsPerSlot,
    preferMinPlayersPerCourt: rule.preferMinPlayersPerCourt,
    courtPriority: rule.courtPriority,
  };
}
