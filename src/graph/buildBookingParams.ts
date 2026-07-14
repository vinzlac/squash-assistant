import type { BookingRule } from "../config.js";
import type { PlanGroupBookingsParams } from "../mcp/resaSquash.js";
import { prioritizePlayers } from "./playerPriority.js";

/**
 * Construit les paramètres d'appel plan_group_bookings à partir d'une
 * BookingRule et des joueurs confirmés (CollectVotes) — logique pure,
 * testable sans mock MCP. Voir bookSlots.ts pour le commentaire sur les
 * champs de BookingRule non transmis (pas d'équivalent côté resa-squash).
 */
export function buildPlanGroupBookingsParams(
  rule: BookingRule,
  confirmedPlayerIds: string[],
  targetDate: string,
): PlanGroupBookingsParams {
  return {
    groupId: rule.resaSquashGroupId,
    onDate: targetDate,
    expectedPlayerIds: prioritizePlayers(confirmedPlayerIds, rule.priorityBookers),
    slotsPerPlayer: rule.maxReservationsPerPlayer,
    dryRun: true,
  };
}
