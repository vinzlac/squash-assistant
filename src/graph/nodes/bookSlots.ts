import { planGroupBookings } from "../../mcp/resaSquash.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

/**
 * POC : toujours dryRun (voir docs/plan/squash-assistant-poc.md §2.2, §6) —
 * ce nœud n'appelle jamais reserve_slot. La confirmation "go" (nœud suivant,
 * waitForGoConfirmation) ne fait que valider le plan proposé pour l'annonce ;
 * le passage à une vraie réservation est un changement de scope explicite
 * pour une phase ultérieure du projet (Phase 4 du plan).
 */
export function createBookSlotsNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { groupConfig, targetDate, confirmedPlayerIds } = state;

    const bookingPlan = await planGroupBookings(deps.resaSquash.client, {
      groupId: groupConfig.resaSquashGroupId,
      onDate: targetDate,
      expectedPlayerIds: confirmedPlayerIds,
      dryRun: true,
    });

    const summary =
      bookingPlan.proposedBookings.length === 0
        ? `[${groupConfig.id}] Aucun créneau proposé pour le ${targetDate}.\n${bookingPlan.warnings.join("\n")}`
        : `[${groupConfig.id}] Plan de réservation (dry-run) pour le ${targetDate} :\n` +
          bookingPlan.proposedBookings
            .map((b) => `• ${b.beginTime}-${b.endTime} (court ${b.court}) — ${b.players.join(" et ")}`)
            .join("\n") +
          `\n\nRéponds "go" pour confirmer.`;

    await sendTelegramMessage(deps.telegram, summary);

    return { bookingPlan };
  };
}

export function hasProposedBookings(state: PipelineStateType): boolean {
  return (state.bookingPlan?.proposedBookings.length ?? 0) > 0;
}
