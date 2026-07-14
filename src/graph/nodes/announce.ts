import { sendMessage } from "../../mcp/huddleBot.js";
import { formatMergedCourtSlots, mergeContiguousSlotsByCourt } from "../slotMerge.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

export function createAnnounceNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { groupConfig, targetDate, goConfirmed, bookingPlan } = state;

    if (!goConfirmed || !bookingPlan) {
      await sendTelegramMessage(
        deps.telegram,
        `[${groupConfig.id}] Pas de "go" reçu — aucune annonce envoyée pour le ${targetDate}.`,
      );
      return {};
    }

    const merged = mergeContiguousSlotsByCourt(bookingPlan.proposedBookings);
    const message = `🏸 Réservation(s) « ${groupConfig.id} »\n\n📅 ${targetDate}\n\n${formatMergedCourtSlots(merged)}`;

    await sendMessage(deps.huddleBot.client, groupConfig.whatsappGroupJid, message);
    await sendTelegramMessage(deps.telegram, `[${groupConfig.id}] Annonce envoyée pour le ${targetDate}.`);

    return {};
  };
}
