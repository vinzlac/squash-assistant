import { planGroupBookings, type GroupBookingPlan } from "../../mcp/resaSquash.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { buildPlanGroupBookingsParams } from "../buildBookingParams.js";
import { withEventLogging } from "../emitEvent.js";
import type { GraphDependencies } from "../dependencies.js";
import type { BookingPlanGroup } from "../state.js";
import type { PipelineStateType } from "../state.js";
import type { BookingRule } from "../../config.js";

/**
 * POC : toujours dryRun (voir docs/plan/squash-assistant-poc.md §2.2, §6) —
 * ce nœud n'appelle jamais reserve_slot. La confirmation "go" (nœud suivant,
 * waitForGoConfirmation) ne fait que valider le plan proposé pour l'annonce ;
 * le passage à une vraie réservation est un changement de scope explicite
 * pour une phase ultérieure du projet (Phase 4 du plan).
 *
 * Un appel plan_group_bookings par heure candidate ayant des joueurs
 * confirmés (voir resolveVotes/collectVotes) — chaque heure du sondage
 * multi-choix peut aboutir à un plan de réservation distinct, sur des courts
 * différents. Voir ADR-013.
 */
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

export function createBookSlotsNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate, confirmedPlayerIdsByTime } = state;

    const bookingPlanGroups = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "booking", targetDate },
      async () => {
        const groups: BookingPlanGroup[] = [];
        for (const startTime of bookingRule.candidateStartTimes) {
          const confirmedPlayerIds = confirmedPlayerIdsByTime[startTime] ?? [];

          // plan_group_bookings rejette expectedPlayerIds en-deçà de 2 éléments (validation MCP) —
          // pas assez de joueurs confirmés pour un court est un résultat normal (pas une erreur),
          // à traiter comme "aucun créneau proposé" plutôt que de laisser l'appel MCP échouer.
          if (confirmedPlayerIds.length < bookingRule.minPlayersPerCourt) {
            groups.push({ startTime, plan: notEnoughPlayersPlan(bookingRule, targetDate, startTime, confirmedPlayerIds) });
            continue;
          }

          const params = buildPlanGroupBookingsParams(bookingRule, confirmedPlayerIds, targetDate, startTime);
          const plan = await planGroupBookings(deps.resaSquash.client, params);
          groups.push({ startTime, plan });
        }
        return { result: groups, detail: { step: "plan-proposed", groups } };
      },
    );

    const summaryParts = bookingPlanGroups.map((g) =>
      g.plan.proposedBookings.length === 0
        ? `${g.startTime} : aucun créneau (${g.plan.warnings.join(" ")})`
        : `${g.startTime} :\n` +
          g.plan.proposedBookings
            .map(
              (b) =>
                `  • ${b.slotTime}-${b.slotEndTime} (court ${b.court}) — ${b.userId}${b.partnerId ? ` et ${b.partnerId}` : ""}`,
            )
            .join("\n"),
    );
    const totalProposed = bookingPlanGroups.reduce((n, g) => n + g.plan.proposedBookings.length, 0);
    const summary =
      totalProposed === 0
        ? `[${bookingRule.id}] Aucun créneau proposé pour le ${targetDate} (toutes heures confondues).\n${summaryParts.join("\n")}`
        : `[${bookingRule.id}] Plan de réservation (dry-run) pour le ${targetDate} :\n${summaryParts.join("\n\n")}\n\nRéponds "go" pour confirmer.`;

    await sendTelegramMessage(deps.telegram, summary);

    return { bookingPlanGroups };
  };
}

export function hasProposedBookings(state: PipelineStateType): boolean {
  return (state.bookingPlanGroups ?? []).some((g) => g.plan.proposedBookings.length > 0);
}
