import { getResponses } from "../../mcp/huddleBot.js";
import { lookupPlayerByPhone } from "../../mcp/resaSquash.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { withEventLogging } from "../emitEvent.js";
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

        const { responses } = await getResponses(deps.huddleBot.client, pollRequestId);
        const goingRespondents = responses.filter((r) => r.statut === "oui");

        const confirmedPlayerIds: string[] = [];
        const unresolvedNames: string[] = [];
        for (const respondent of goingRespondents) {
          const phone = respondent.phone ? `+${respondent.phone}` : undefined;
          const lookup = phone
            ? await lookupPlayerByPhone(deps.resaSquash.client, phone)
            : { found: false as const };
          if (lookup.found && lookup.userId) {
            confirmedPlayerIds.push(lookup.userId);
          } else {
            unresolvedNames.push(respondent.member);
          }
        }

        const result = { confirmedPlayerIds, unresolvedNames };
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
