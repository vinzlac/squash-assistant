import { sendTelegramMessage } from "../../telegram/telegram.js";
import { withEventLogging } from "../emitEvent.js";
import { resolveVotes } from "../resolveVotes.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

export function createCollectVotesNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate, pollRequestId } = state;

    const { confirmedPlayerIds, unresolvedNames } = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "collect_votes", targetDate },
      async () => {
        if (!pollRequestId) {
          throw new Error(`pollRequestId manquant — SendPoll n'a pas été exécuté.`);
        }

        const result = await resolveVotes(deps, pollRequestId);
        return { result, detail: { pollRequestId, ...result } };
      },
    );

    const unresolvedSuffix =
      unresolvedNames.length > 0
        ? `, ${unresolvedNames.length} non résolu(s) côté resa-squash : ${unresolvedNames.join(", ")}`
        : "";
    await sendTelegramMessage(
      deps.telegram,
      `[${bookingRule.id}] ${confirmedPlayerIds.length} joueur(s) confirmé(s)${unresolvedSuffix}.`,
    );

    return { confirmedPlayerIds };
  };
}
