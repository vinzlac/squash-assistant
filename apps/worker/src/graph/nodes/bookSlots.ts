import { listAvailability, listMyReservationsOnDate, type AvailabilitySlot } from "../../mcp/resaSquash.js";
import { getJobRunById } from "../../jobRuns.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { computeShortfall, countPlayersInSessions } from "../capacityPlanning.js";
import { withEventLogging } from "../emitEvent.js";
import { loadPlaySlotsConfig } from "../../planning/loadPlayerPlaySlots.js";
import { planJobBookings } from "../../planning/planJob.js";
import type { AvailableSlot } from "../../planning/courtAssignment.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

function toAvailableSlot(slot: AvailabilitySlot): AvailableSlot {
  return { sessionId: slot.id, court: slot.court, beginTime: slot.time, endTime: slot.endTime };
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
        const playSlots = await loadPlaySlotsConfig(deps.db);

        const groups = planJobBookings(
          bookingRule,
          targetDate,
          confirmedPlayerIdsByTime,
          volunteerSubstituteIds,
          availableSlots,
          apiUserId,
          playSlots,
        );
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
    const job = jobRunId ? await getJobRunById(deps.db, bookingRule.id, jobRunId) : undefined;
    const goHint = job?.auto
      ? `\n\nRéponds "go" pour confirmer — réservation RÉELLE (job automatique).`
      : `\n\nRéponds "go" pour confirmer (dry-run via Telegram ; pour une vraie réservation, utilise l'UI en décochant Dry-run).`;
    const summary =
      totalProposed === 0
        ? `[${bookingRule.id}] Aucun créneau proposé pour le ${targetDate} (toutes heures confondues).\n${summaryParts.join("\n")}`
        : `[${bookingRule.id}] ${warningsBlock}Plan de réservation (planification dry-run) pour le ${targetDate} :\n${summaryParts.join("\n\n")}${goHint}`;

    await sendTelegramMessage(deps.telegram, summary);

    return { bookingPlanGroups };
  };
}

export function hasProposedBookings(state: PipelineStateType): boolean {
  return (state.bookingPlanGroups ?? []).some((g) => g.plan.proposedBookings.length > 0);
}
