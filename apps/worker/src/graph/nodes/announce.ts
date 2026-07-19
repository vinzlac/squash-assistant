import { sendMessage } from "../../mcp/huddleBot.js";
import { formatMergedCourtSlots, mergeContiguousSlotsByCourt } from "../slotMerge.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { emitEvent, withEventLogging } from "../emitEvent.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

export function createAnnounceNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate, goConfirmed, bookingPlan } = state;

    if (!goConfirmed || !bookingPlan) {
      await emitEvent(deps.db, {
        bookingRuleId: bookingRule.id,
        jobRunId,
        type: "booking",
        status: "success",
        targetDate,
        detail: { step: "cancelled", reason: "no-go-confirmation" },
      });
      await sendTelegramMessage(
        deps.telegram,
        `[${bookingRule.id}] Pas de "go" reçu — aucune annonce envoyée pour le ${targetDate}.`,
      );
      return {};
    }

    const message = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "booking", targetDate },
      async () => {
        const slots = bookingPlan.proposedBookings.map((b) => ({
          court: b.court,
          beginTime: b.slotTime,
          endTime: b.slotEndTime,
        }));
        const merged = mergeContiguousSlotsByCourt(slots);
        const message = `🏸 Réservation(s) « ${bookingRule.id} »\n\n📅 ${targetDate}\n\n${formatMergedCourtSlots(merged)}`;

        await sendMessage(deps.huddleBot.client, bookingRule.whatsappGroupJid, message);
        return { result: message, detail: { step: "announced", merged, message } };
      },
    );

    await sendTelegramMessage(deps.telegram, `[${bookingRule.id}] Annonce envoyée pour le ${targetDate}.`);

    return { announceMessage: message };
  };
}
