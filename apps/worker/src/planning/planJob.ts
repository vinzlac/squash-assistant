import { buildGroupBookingPlanParams } from "../graph/buildGroupBookingPlanParams.js";
import { computeShortfall, splitByAvailabilityWindow } from "../graph/capacityPlanning.js";
import type { BookingPlanGroup } from "../graph/state.js";
import type { BookingRule } from "../config.js";
import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import { computeGroupBookingPlan, type ComputeGroupBookingPlanInput } from "./groupBookingPlan.js";
import type { AvailableSlot } from "./courtAssignment.js";
import {
  buildPlayerPlaySlotsMap,
  DEFAULT_PLAY_SLOTS,
  type PlayerPlaySlots,
  type PlaySlotsDefaults,
} from "./playerPlaySlots.js";
import {
  appendBookingsToGroupPlan,
  buildOngoingSessionsFromPlan,
  extendSessionForLateJoiners,
  findMergeableSession,
  type OngoingSession,
} from "./sessionExtension.js";

export interface PlanJobPlaySlotsOptions {
  defaults?: PlaySlotsDefaults;
  overrides?: ReadonlyMap<string, PlayerPlaySlots> | Readonly<Record<string, PlayerPlaySlots>>;
}
function mergedIntoSessionPlan(
  bookingRule: BookingRule,
  targetDate: string,
  startTime: string,
  orphanIds: string[],
  anchorStartTime: string,
  court: number,
): GroupBookingPlan {
  return {
    dryRun: true,
    proposedBookings: [],
    warnings: [
      `Joueur(s) ${orphanIds.join(", ")} fusionné(s) sur la session ${anchorStartTime} (court ${court}) — pas de plan séparé à ${startTime}.`,
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

function applyPlanToTracking(
  bookingRule: BookingRule,
  plan: GroupBookingPlan,
  confirmedPlayerIds: string[],
  volunteerSubstituteIds: string[],
  startTime: string,
  usedTodayIds: Set<string>,
  playerDailyCounts: Map<string, number>,
): void {
  for (const id of substitutesUsedInPlan(bookingRule, volunteerSubstituteIds, plan, confirmedPlayerIds)) {
    usedTodayIds.add(id);
  }
  for (const b of plan.proposedBookings) {
    for (const id of [b.userId, b.partnerId]) {
      if (!id) continue;
      playerDailyCounts.set(id, (playerDailyCounts.get(id) ?? 0) + 1);
    }
  }
}

function recordSessionsFromGroup(
  plan: GroupBookingPlan,
  startTime: string,
  groupIndex: number,
  confirmedPlayerIds: string[],
  ongoingSessions: OngoingSession[],
): void {
  for (const session of buildOngoingSessionsFromPlan(plan, startTime, groupIndex, confirmedPlayerIds)) {
    ongoingSessions.push(session);
  }
}

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
  playerPlaySlots: ReturnType<typeof buildPlayerPlaySlotsMap>,
  playSlotsDefaults: PlaySlotsDefaults,
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
  const input: ComputeGroupBookingPlanInput = {
    ...params,
    availableSlots,
    usedSessionIds,
    apiUserId,
    existingDailyCounts,
    playerPlaySlots,
    playSlotsDefaults,
  };
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
  const escalatedPlan = computeGroupBookingPlan({
    ...escalatedParams,
    availableSlots,
    usedSessionIds,
    apiUserId,
    existingDailyCounts,
    playerPlaySlots,
    playSlotsDefaults,
  });
  return escalatedPlan.proposedBookings.length > plan.proposedBookings.length ? escalatedPlan : plan;
}

/**
 * Ajoute `unexpectedPlayersMargin` joueurs "imprévus" à chaque heure ayant déjà des confirmés —
 * traités exactement comme des confirmés réels (mêmes créneaux, même pairing), pas comme des
 * prête-noms de repli. Sourcés du même pool que la substitution quota (volontaires du sondage
 * "Prête mon nom", ADR-017, prioritaires sur substituteBookers de la règle, ADR-016) — jamais
 * deux fois le même jour, jamais un id déjà confirmé. Une heure sans aucun confirmé ne reçoit pas
 * de marge (rien à provisionner en plus de zéro joueur).
 */
function applyUnexpectedPlayersMargin(
  bookingRule: BookingRule,
  confirmedPlayerIdsByTime: Record<string, string[]>,
  volunteerSubstituteIds: string[],
): Record<string, string[]> {
  if (bookingRule.unexpectedPlayersMargin <= 0) return confirmedPlayerIdsByTime;

  const alreadyConfirmed = new Set(Object.values(confirmedPlayerIdsByTime).flat());
  const eligible = (id: string) => !alreadyConfirmed.has(id);
  const volunteers = volunteerSubstituteIds.filter(eligible);
  const volunteerSet = new Set(volunteers);
  const defaults = bookingRule.substituteBookers.filter((id) => eligible(id) && !volunteerSet.has(id));
  const pool = [...volunteers, ...defaults];
  const usedForMargin = new Set<string>();
  const result: Record<string, string[]> = {};

  for (const [time, ids] of Object.entries(confirmedPlayerIdsByTime)) {
    if (ids.length === 0) {
      result[time] = ids;
      continue;
    }
    const extra: string[] = [];
    for (const candidate of pool) {
      if (extra.length >= bookingRule.unexpectedPlayersMargin) break;
      if (usedForMargin.has(candidate)) continue;
      extra.push(candidate);
      usedForMargin.add(candidate);
    }
    result[time] = [...ids, ...extra];
  }

  return result;
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
  playSlotsOptions?: PlanJobPlaySlotsOptions,
): BookingPlanGroup[] {
  const withMargin = applyUnexpectedPlayersMargin(bookingRule, confirmedPlayerIdsByTime, volunteerSubstituteIds);
  const groups: BookingPlanGroup[] = [];
  const usedTodayIds = new Set<string>(Object.values(withMargin).flat());
  const usedSessionIds = new Set<string>();
  const playerDailyCounts = new Map<string, number>();
  const ongoingSessions: OngoingSession[] = [];

  const playSlotsDefaults = playSlotsOptions?.defaults ?? DEFAULT_PLAY_SLOTS;
  const allPlayerIds = [
    ...new Set([
      ...Object.values(withMargin).flat(),
      ...volunteerSubstituteIds,
      ...bookingRule.substituteBookers,
    ]),
  ];
  const playerPlaySlots = buildPlayerPlaySlotsMap(
    allPlayerIds,
    playSlotsDefaults,
    playSlotsOptions?.overrides ?? new Map(),
  );

  for (const startTime of bookingRule.candidateStartTimes) {
    const confirmedPlayerIds = withMargin[startTime] ?? [];

    if (confirmedPlayerIds.length < bookingRule.minPlayersPerCourt) {
      const mergeTarget = findMergeableSession(
        ongoingSessions,
        startTime,
        confirmedPlayerIds.length,
        bookingRule.maxPlayersPerCourt,
        bookingRule.availabilityWindowHours,
      );

      if (mergeTarget && confirmedPlayerIds.length > 0) {
        const anchorGroup = groups[mergeTarget.groupIndex]!;
        const mergeWarnings: string[] = [];
        const eligible = (id: string) => !usedTodayIds.has(id) && !confirmedPlayerIds.includes(id);
        const volunteers = volunteerSubstituteIds.filter(eligible);
        const volunteerSet = new Set(volunteers);
        const defaults = bookingRule.substituteBookers.filter((id) => eligible(id) && !volunteerSet.has(id));
        const substituteQueue = [...volunteers, ...defaults];
        const extra = extendSessionForLateJoiners({
          session: mergeTarget,
          lateJoinerIds: confirmedPlayerIds,
          joinTime: startTime,
          targetDate,
          groupId: bookingRule.resaSquashGroupId,
          slotsPerPlayer: bookingRule.maxReservationsPerPlayer,
          maxPlayersPerCourt: bookingRule.maxPlayersPerCourt,
          maxDailyReservationsPerPlayer: bookingRule.maxDailyReservationsPerPlayer,
          availabilityWindowHours: bookingRule.availabilityWindowHours,
          availableSlots,
          usedSessionIds,
          substituteQueue,
          existingDailyCounts: Object.fromEntries(playerDailyCounts),
          apiUserId,
          playerPlaySlots,
          playSlotsDefaults,
          warnings: mergeWarnings,
        });
        appendBookingsToGroupPlan(anchorGroup.plan, extra, mergeTarget.rotatingPlayerIds);
        anchorGroup.plan.warnings.push(...mergeWarnings);
        applyPlanToTracking(
          bookingRule,
          { ...anchorGroup.plan, proposedBookings: extra },
          confirmedPlayerIds,
          volunteerSubstituteIds,
          startTime,
          usedTodayIds,
          playerDailyCounts,
        );
        groups.push({
          startTime,
          plan: mergedIntoSessionPlan(
            bookingRule,
            targetDate,
            startTime,
            confirmedPlayerIds,
            mergeTarget.anchorStartTime,
            mergeTarget.court,
          ),
          outOfWindowSessionIds: [],
        });
        continue;
      }

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
      playerPlaySlots,
      playSlotsDefaults,
    );
    applyPlanToTracking(
      bookingRule,
      plan,
      confirmedPlayerIds,
      volunteerSubstituteIds,
      startTime,
      usedTodayIds,
      playerDailyCounts,
    );
    const { outOfWindowSessionIds } = splitByAvailabilityWindow(plan, startTime, bookingRule.availabilityWindowHours);
    for (const b of plan.proposedBookings) {
      if (!outOfWindowSessionIds.includes(b.sessionId)) usedSessionIds.add(b.sessionId);
    }
    const groupIndex = groups.length;
    groups.push({ startTime, plan, outOfWindowSessionIds });
    recordSessionsFromGroup(plan, startTime, groupIndex, confirmedPlayerIds, ongoingSessions);
  }

  return groups;
}
