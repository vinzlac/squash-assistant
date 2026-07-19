import { sendTelegramMessage } from "../../telegram/telegram.js";
import { withEventLogging } from "../emitEvent.js";
import { resolveVotes } from "../resolveVotes.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

export function createCollectVotesNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate, pollRequestId } = state;

    const { confirmedPlayerIdsByTime, unresolvedNames } = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "collect_votes", targetDate },
      async () => {
        if (!pollRequestId) {
          throw new Error(`pollRequestId manquant — SendPoll n'a pas été exécuté.`);
        }

        const result = await resolveVotes(deps, pollRequestId, bookingRule.candidateStartTimes);
        return { result, detail: { pollRequestId, ...result } };
      },
    );

    const perTime = bookingRule.candidateStartTimes
      .map((time) => `${time} : ${confirmedPlayerIdsByTime[time]?.length ?? 0}`)
      .join(", ");
    const unresolvedSuffix =
      unresolvedNames.length > 0
        ? `, ${unresolvedNames.length} non résolu(s) côté resa-squash : ${unresolvedNames.join(", ")}`
        : "";
    await sendTelegramMessage(deps.telegram, `[${bookingRule.id}] Confirmés par heure — ${perTime}${unresolvedSuffix}.`);

    return { confirmedPlayerIdsByTime };
  };
}
