import { getResponses } from "../mcp/huddleBot.js";
import { lookupPlayerByPhone } from "../mcp/resaSquash.js";
import type { GraphDependencies } from "./dependencies.js";

export interface ResolvedVotes {
  /** Une entrée par heure candidate (même vide) — jamais undefined pour une heure de candidateStartTimes. */
  confirmedPlayerIdsByTime: Record<string, string[]>;
  unresolvedNames: string[];
}

/**
 * Lit les réponses au sondage (get_responses) et résout chaque votant en
 * userId resa-squash (lookup_player_by_phone), groupé par heure choisie
 * (statut = libellé exact de l'option votée, ex. "18H45" — huddle-bot
 * ADR-011). Les votes "Non"/ambigus/sans réponse ne rentrent dans aucun
 * groupe. Partagé entre le nœud CollectVotes (1er passage) et
 * triggerRecollectVotes (relecture manuelle, cf. scheduler.ts).
 */
export async function resolveVotes(
  deps: GraphDependencies,
  pollRequestId: string,
  candidateStartTimes: string[],
): Promise<ResolvedVotes> {
  const { responses } = await getResponses(deps.huddleBot.client, pollRequestId);
  const candidateSet = new Set(candidateStartTimes);

  const confirmedPlayerIdsByTime: Record<string, string[]> = {};
  for (const time of candidateStartTimes) {
    confirmedPlayerIdsByTime[time] = [];
  }
  const unresolvedNames: string[] = [];

  for (const respondent of responses) {
    if (!candidateSet.has(respondent.statut)) continue;
    const phone = respondent.phone ? `+${respondent.phone}` : undefined;
    const lookup = phone ? await lookupPlayerByPhone(deps.resaSquash.client, phone) : { found: false as const };
    if (lookup.found && lookup.userId) {
      confirmedPlayerIdsByTime[respondent.statut]!.push(lookup.userId);
    } else {
      unresolvedNames.push(respondent.member);
    }
  }

  return { confirmedPlayerIdsByTime, unresolvedNames };
}
