import { buildGroupBookingPlanParams } from "../graph/buildGroupBookingPlanParams.js";
import { computeShortfall, splitByAvailabilityWindow } from "../graph/capacityPlanning.js";
import type { BookingPlanGroup } from "../graph/state.js";
import type { BookingRule } from "../config.js";
import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import { computeGroupBookingPlan, type ComputeGroupBookingPlanInput } from "./groupBookingPlan.js";
import type { AvailableSlot } from "./courtAssignment.js";

function notEnoughPlayersPlan(
  bookingRule: BookingRule,
  targetDate: string,
  startTime: string,
  confirmedPlayerIds: string[],
): GroupBookingPlan {
  return {
    dryRun: true,
    proposedBookings: [],
    warnings: [
      `Pas assez de joueurs confirmés à ${startTime} (${confirmedPlayerIds.length}/${bookingRule.minPlayersPerCourt} requis) pour proposer un créneau.`,
    ],
    meta: {
      courtsNeeded: 0,
      roundsPlanned: 0,
      dryRun: true,
      groupLabel: bookingRule.id,
      recurringWeekday: new Date(targetDate).getDay(),
      recurringStartTime: startTime,
      slotsPerPlayer: 0,
      groupMinSlotsPerPlayer: 0,
      groupMaxSlotsPerPlayer: 0,
      pairCount: 0,
    },
  };
}

/**
 * Calcule le plan pour une heure candidate, avec escalade automatique min→max joueurs/court
 * si la 1ère tentative ne suffit pas (ADR-014) — même logique de retry qu'avant, mais sur le
 * moteur local au lieu d'un 2e appel MCP.
 */
function planWithEscalation(
  bookingRule: BookingRule,
  confirmedPlayerIds: string[],
  targetDate: string,
  startTime: string,
  usedTodayIds: ReadonlySet<string>,
  volunteerSubstituteIds: string[],
  availableSlots: AvailableSlot[],
  usedSessionIds: ReadonlySet<string>,
  apiUserId: string | null,
  existingDailyCounts: Readonly<Record<string, number>>,
): GroupBookingPlan {
  const params = buildGroupBookingPlanParams(
    bookingRule,
    confirmedPlayerIds,
    targetDate,
    startTime,
    undefined,
    usedTodayIds,
    volunteerSubstituteIds,
  );
  const input: ComputeGroupBookingPlanInput = { ...params, availableSlots, usedSessionIds, apiUserId, existingDailyCounts };
  const plan = computeGroupBookingPlan(input);

  if (!bookingRule.preferMinPlayersPerCourt || computeShortfall(plan) === 0) {
    return plan;
  }

  const escalatedParams = buildGroupBookingPlanParams(
    bookingRule,
    confirmedPlayerIds,
    targetDate,
    startTime,
    false,
    usedTodayIds,
    volunteerSubstituteIds,
  );
  const escalatedPlan = computeGroupBookingPlan({ ...escalatedParams, availableSlots, usedSessionIds, apiUserId, existingDailyCounts });
  return escalatedPlan.proposedBookings.length > plan.proposedBookings.length ? escalatedPlan : plan;
}

function substitutesUsedInPlan(
  rule: BookingRule,
  volunteerSubstituteIds: string[],
  plan: GroupBookingPlan,
  confirmedPlayerIds: string[],
): string[] {
  const confirmedSet = new Set(confirmedPlayerIds);
  const substituteSet = new Set([...volunteerSubstituteIds, ...rule.substituteBookers]);
  const used = new Set<string>();
  for (const b of plan.proposedBookings) {
    for (const id of [b.userId, b.partnerId]) {
      if (id && substituteSet.has(id) && !confirmedSet.has(id)) {
        used.add(id);
      }
    }
  }
  return [...used];
}

/**
 * Boucle sur les heures candidates d'une règle et calcule un plan par heure, en threadant
 * usedSessionIds (double-booking structurellement impossible entre heures, ADR-018) et
 * existingDailyCounts (plafond de résas/jour par joueur, cf. corrections du 2026-08-01) d'une
 * heure à l'autre. Fonction pure, aucun I/O — partagée entre le nœud réel (bookSlots.ts, qui
 * fournit availableSlots via list_availability) et le simulateur (simulateScenario.ts, qui
 * fournit une disponibilité synthétique).
 */
export function planJobBookings(
  bookingRule: BookingRule,
  targetDate: string,
  confirmedPlayerIdsByTime: Record<string, string[]>,
  volunteerSubstituteIds: string[],
  availableSlots: AvailableSlot[],
  apiUserId: string | null,
): BookingPlanGroup[] {
  const groups: BookingPlanGroup[] = [];
  const usedTodayIds = new Set<string>(Object.values(confirmedPlayerIdsByTime).flat());
  const usedSessionIds = new Set<string>();
  const playerDailyCounts = new Map<string, number>();

  for (const startTime of bookingRule.candidateStartTimes) {
    const confirmedPlayerIds = confirmedPlayerIdsByTime[startTime] ?? [];

    if (confirmedPlayerIds.length < bookingRule.minPlayersPerCourt) {
      groups.push({
        startTime,
        plan: notEnoughPlayersPlan(bookingRule, targetDate, startTime, confirmedPlayerIds),
        outOfWindowSessionIds: [],
      });
      continue;
    }

    const plan = planWithEscalation(
      bookingRule,
      confirmedPlayerIds,
      targetDate,
      startTime,
      usedTodayIds,
      volunteerSubstituteIds,
      availableSlots,
      usedSessionIds,
      apiUserId,
      Object.fromEntries(playerDailyCounts),
    );
    for (const id of substitutesUsedInPlan(bookingRule, volunteerSubstituteIds, plan, confirmedPlayerIds)) {
      usedTodayIds.add(id);
    }
    for (const b of plan.proposedBookings) {
      for (const id of [b.userId, b.partnerId]) {
        if (!id) continue;
        playerDailyCounts.set(id, (playerDailyCounts.get(id) ?? 0) + 1);
      }
    }
    const { outOfWindowSessionIds } = splitByAvailabilityWindow(plan, startTime, bookingRule.availabilityWindowHours);
    for (const b of plan.proposedBookings) {
      if (!outOfWindowSessionIds.includes(b.sessionId)) usedSessionIds.add(b.sessionId);
    }
    groups.push({ startTime, plan, outOfWindowSessionIds });
  }

  return groups;
}
