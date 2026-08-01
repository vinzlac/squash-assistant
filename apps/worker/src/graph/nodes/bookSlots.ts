import { listAvailability, listMyReservationsOnDate, type AvailabilitySlot, type GroupBookingPlan } from "../../mcp/resaSquash.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { buildGroupBookingPlanParams } from "../buildGroupBookingPlanParams.js";
import { computeShortfall, countPlayersInSessions, splitByAvailabilityWindow } from "../capacityPlanning.js";
import { withEventLogging } from "../emitEvent.js";
import { computeGroupBookingPlan, type ComputeGroupBookingPlanInput } from "../../planning/groupBookingPlan.js";
import type { AvailableSlot } from "../../planning/courtAssignment.js";
import type { GraphDependencies } from "../dependencies.js";
import type { BookingPlanGroup } from "../state.js";
import type { PipelineStateType } from "../state.js";
import type { BookingRule } from "../../config.js";

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

function toAvailableSlot(slot: AvailabilitySlot): AvailableSlot {
  return { sessionId: slot.id, court: slot.court, beginTime: slot.time, endTime: slot.endTime };
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

export function createBookSlotsNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate, confirmedPlayerIdsByTime, volunteerSubstituteIds } = state;

    const bookingPlanGroups = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "booking", targetDate },
      async () => {
        const { availability } = await listAvailability(deps.resaSquash.client, targetDate, targetDate);
        const availableSlots = availability.flatMap((day) => day.slots.filter((s) => s.available).map(toAvailableSlot));

        // Le titulaire de la clé API n'a lui-même aucun plafond de résas/jour — seul son userId
        // sert à l'exclure du contrôle de quota (voir ComputeGroupBookingPlanInput.apiUserId).
        const { userId: apiUserId } = await listMyReservationsOnDate(deps.resaSquash.client, targetDate);

        const groups: BookingPlanGroup[] = [];
        const usedTodayIds = new Set<string>(Object.values(confirmedPlayerIdsByTime).flat());
        const usedSessionIds = new Set<string>();
        // Plafond de résas/jour par joueur (hors titulaire) — cumulé au fil des heures candidates du
        // même job, pas d'appel TeamR possible pour un joueur autre que le titulaire (voir ADR-016).
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
        return { result: groups, detail: { step: "plan-proposed", groups } };
      },
    );

    const capacityWarnings = bookingPlanGroups
      .map((g) => {
        const outOfWindowPlayers = countPlayersInSessions(g.plan, g.outOfWindowSessionIds);
        const shortfall = computeShortfall(g.plan) + outOfWindowPlayers;
        if (shortfall === 0) return null;
        return `⚠️ ${g.startTime} : ~${shortfall} joueur(s) risquent de ne pas avoir de créneau — voir le détail à l'étape 3.`;
      })
      .filter((w): w is string => w !== null);

    const summaryParts = bookingPlanGroups.map((g) =>
      g.plan.proposedBookings.length === 0
        ? `${g.startTime} : aucun créneau (${g.plan.warnings.join(" ")})`
        : `${g.startTime} :\n` +
          g.plan.proposedBookings
            .map(
              (b) =>
                `  • ${b.slotTime}-${b.slotEndTime} (court ${b.court}) — ${b.userId}${b.partnerId ? ` et ${b.partnerId}` : ""}` +
                (g.outOfWindowSessionIds.includes(b.sessionId) ? " [hors fenêtre, non réservé]" : ""),
            )
            .join("\n"),
    );
    const totalProposed = bookingPlanGroups.reduce((n, g) => n + g.plan.proposedBookings.length, 0);
    const warningsBlock = capacityWarnings.length > 0 ? `${capacityWarnings.join("\n")}\n\n` : "";
    const summary =
      totalProposed === 0
        ? `[${bookingRule.id}] Aucun créneau proposé pour le ${targetDate} (toutes heures confondues).\n${summaryParts.join("\n")}`
        : `[${bookingRule.id}] ${warningsBlock}Plan de réservation (dry-run) pour le ${targetDate} :\n${summaryParts.join("\n\n")}\n\nRéponds "go" pour confirmer.`;

    await sendTelegramMessage(deps.telegram, summary);

    return { bookingPlanGroups };
  };
}

export function hasProposedBookings(state: PipelineStateType): boolean {
  return (state.bookingPlanGroups ?? []).some((g) => g.plan.proposedBookings.length > 0);
}
