import { askPoll } from "../../mcp/huddleBot.js";
import { setJobRunPollInfo } from "../../jobRuns.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { withEventLogging } from "../emitEvent.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";
import { buildPollQuestion } from "./pollQuestion.js";

export function createSendPollNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate } = state;

    const requestId = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "poll", targetDate },
      async () => {
        const question = buildPollQuestion(targetDate, bookingRule.sessionStartTime);
        const { requestId, msgId } = await askPoll(deps.huddleBot.client, bookingRule.whatsappGroupJid, question);
        await setJobRunPollInfo(deps.db, jobRunId, requestId, msgId);
        return { result: requestId, detail: { question, requestId, msgId } };
      },
    );

    await sendTelegramMessage(
      deps.telegram,
      `[${bookingRule.id}] Sondage envoyé pour le ${targetDate} (requestId=${requestId}).`,
    );

    return { pollRequestId: requestId };
  };
}
