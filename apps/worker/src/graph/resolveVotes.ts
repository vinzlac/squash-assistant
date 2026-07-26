import { getResponses } from "../mcp/huddleBot.js";
import { lookupPlayerByPhone } from "../mcp/resaSquash.js";
import type { GraphDependencies } from "./dependencies.js";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "./nodes/pollQuestion.js";

export interface ResolvedVotes {
  /** Une entrée par heure candidate (même vide) — jamais undefined pour une heure de candidateStartTimes. */
  confirmedPlayerIdsByTime: Record<string, string[]>;
  /** Prête-noms volontaires cette semaine (option de sondage dédiée, ADR-017) — par job, pas par heure. */
  volunteerSubstituteIds: string[];
  unresolvedNames: string[];
}

/**
 * Lit les réponses au sondage (get_responses) et résout chaque votant en
 * userId resa-squash (lookup_player_by_phone), groupé par heure choisie
 * (statut = libellé exact de l'option votée, ex. "18H45" — huddle-bot
 * ADR-011). Les "Non" purs/ambigus/sans réponse ne rentrent dans aucun
 * groupe ; les "prête-nom volontaire" (ADR-017) sont résolus à part, jamais
 * comme joueurs confirmés. Partagé entre le nœud CollectVotes (1er passage)
 * et triggerRecollectVotes (relecture manuelle, cf. scheduler.ts).
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
  const volunteerSubstituteIds: string[] = [];
  const unresolvedNames: string[] = [];

  for (const respondent of responses) {
    const isCandidateTime = candidateSet.has(respondent.statut);
    const isSubstituteVolunteer = respondent.statut === SUBSTITUTE_VOLUNTEER_POLL_OPTION;
    if (!isCandidateTime && !isSubstituteVolunteer) continue;

    const phone = respondent.phone ? `+${respondent.phone}` : undefined;
    const lookup = phone ? await lookupPlayerByPhone(deps.resaSquash.client, phone) : { found: false as const };
    if (lookup.found && lookup.userId) {
      if (isSubstituteVolunteer) {
        volunteerSubstituteIds.push(lookup.userId);
      } else {
        confirmedPlayerIdsByTime[respondent.statut]!.push(lookup.userId);
      }
    } else {
      unresolvedNames.push(respondent.member);
    }
  }

  return { confirmedPlayerIdsByTime, volunteerSubstituteIds, unresolvedNames };
}
