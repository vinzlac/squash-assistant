import { askPoll } from "../../mcp/huddleBot.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { withEventLogging } from "../emitEvent.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

export function createSendPollNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, targetDate } = state;

    const requestId = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, type: "poll", targetDate },
      async () => {
        const question = `Qui joue le ${targetDate} ?`;
        const { requestId } = await askPoll(deps.huddleBot.client, bookingRule.whatsappGroupJid, question);
        return { result: requestId, detail: { question, requestId } };
      },
    );

    await sendTelegramMessage(
      deps.telegram,
      `[${bookingRule.id}] Sondage envoyé pour le ${targetDate} (requestId=${requestId}).`,
    );

    return { pollRequestId: requestId };
  };
}
