import { getResponses } from "../mcp/huddleBot.js";
import { lookupPlayerByPhone } from "../mcp/resaSquash.js";
import type { GraphDependencies } from "./dependencies.js";

export interface ResolvedVotes {
  confirmedPlayerIds: string[];
  unresolvedNames: string[];
}

/**
 * Lit les réponses au sondage (get_responses) et résout chaque "oui" en
 * userId resa-squash (lookup_player_by_phone). Partagé entre le nœud
 * CollectVotes (1er passage) et triggerRecollectVotes (relecture manuelle
 * pour prendre en compte un vote arrivé/changé après coup, cf. scheduler.ts).
 */
export async function resolveVotes(
  deps: GraphDependencies,
  pollRequestId: string,
): Promise<ResolvedVotes> {
  const { responses } = await getResponses(deps.huddleBot.client, pollRequestId);
  const goingRespondents = responses.filter((r) => r.statut === "oui");

  const confirmedPlayerIds: string[] = [];
  const unresolvedNames: string[] = [];
  for (const respondent of goingRespondents) {
    const phone = respondent.phone ? `+${respondent.phone}` : undefined;
    const lookup = phone ? await lookupPlayerByPhone(deps.resaSquash.client, phone) : { found: false as const };
    if (lookup.found && lookup.userId) {
      confirmedPlayerIds.push(lookup.userId);
    } else {
      unresolvedNames.push(respondent.member);
    }
  }

  return { confirmedPlayerIds, unresolvedNames };
}
