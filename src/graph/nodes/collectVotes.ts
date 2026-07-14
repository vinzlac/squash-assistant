import { getResponses } from "../../mcp/huddleBot.js";
import { lookupPlayerByPhone } from "../../mcp/resaSquash.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

function phoneFromJid(jid: string): string | undefined {
  const match = jid.match(/^(\d+)@/);
  return match ? `+${match[1]}` : undefined;
}

export function createCollectVotesNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { groupConfig, pollRequestId } = state;
    if (!pollRequestId) {
      throw new Error(`[${groupConfig.id}] pollRequestId manquant — SendPoll n'a pas été exécuté.`);
    }

    const { responses } = await getResponses(deps.huddleBot.client, pollRequestId);
    const goingRespondents = responses.filter((r) => r.status === "oui");

    const confirmedPlayerIds: string[] = [];
    const unresolvedNames: string[] = [];
    for (const respondent of goingRespondents) {
      const phone = phoneFromJid(respondent.jid);
      const lookup = phone ? await lookupPlayerByPhone(deps.resaSquash.client, phone) : { found: false as const };
      if (lookup.found && lookup.userId) {
        confirmedPlayerIds.push(lookup.userId);
      } else {
        unresolvedNames.push(respondent.name);
      }
    }

    const unresolvedSuffix =
      unresolvedNames.length > 0
        ? `, ${unresolvedNames.length} non résolu(s) côté resa-squash : ${unresolvedNames.join(", ")}`
        : "";
    await sendTelegramMessage(
      deps.telegram,
      `[${groupConfig.id}] ${confirmedPlayerIds.length} joueur(s) confirmé(s)${unresolvedSuffix}.`,
    );

    return { confirmedPlayerIds };
  };
}
