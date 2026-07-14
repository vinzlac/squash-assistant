import { askPoll } from "../../mcp/huddleBot.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

export function createSendPollNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { groupConfig, targetDate } = state;
    const question = `Qui joue le ${targetDate} ? Réponds Oui/Non.`;

    const { requestId } = await askPoll(deps.huddleBot.client, groupConfig.whatsappGroupJid, question);

    await sendTelegramMessage(
      deps.telegram,
      `[${groupConfig.id}] Sondage envoyé pour le ${targetDate} (requestId=${requestId}).`,
    );

    return { pollRequestId: requestId };
  };
}
