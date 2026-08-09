import { filterCandidateTimesByClosures } from "../../closures/filterCandidateTimes.js";
import { loadClubClosuresForDate } from "../../closures/loadClubClosures.js";
import { askPoll, sendMessage } from "../../mcp/huddleBot.js";
import { setJobRunPollInfo } from "../../jobRuns.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { withEventLogging } from "../emitEvent.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";
import { buildClubClosedMessage, buildPollOptions, buildPollQuestion } from "./pollQuestion.js";

export function createSendPollNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate } = state;
    const closures = await loadClubClosuresForDate(deps.db, targetDate);
    const { openTimes, closedTimes } = filterCandidateTimesByClosures(
      targetDate,
      bookingRule.candidateStartTimes,
      closures,
    );

    if (openTimes.length === 0) {
      const message = buildClubClosedMessage(targetDate);
      await withEventLogging(
        deps,
        { bookingRuleId: bookingRule.id, jobRunId, type: "club-closed", targetDate },
        async () => {
          await sendMessage(deps.huddleBot.client, bookingRule.whatsappGroupJid, message);
          return { result: message, detail: { message, closedTimes } };
        },
      );
      await sendTelegramMessage(
        deps.telegram,
        `[${bookingRule.id}] Club fermé le ${targetDate} — message envoyé, pipeline arrêté.`,
      );
      return { clubClosed: true };
    }

    const requestId = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "poll", targetDate },
      async () => {
        const question = buildPollQuestion(targetDate, openTimes, closedTimes);
        const options = buildPollOptions(openTimes);
        const { requestId, msgId } = await askPoll(
          deps.huddleBot.client,
          bookingRule.whatsappGroupJid,
          question,
          options,
        );
        await setJobRunPollInfo(deps.db, jobRunId, requestId, msgId);
        return { result: requestId, detail: { question, options, requestId, msgId } };
      },
    );

    await sendTelegramMessage(
      deps.telegram,
      `[${bookingRule.id}] Sondage envoyé pour le ${targetDate} (requestId=${requestId}).`,
    );

    return { pollRequestId: requestId, clubClosed: false };
  };
}
