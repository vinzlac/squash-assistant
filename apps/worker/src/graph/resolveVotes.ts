import { getResponses } from "../mcp/huddleBot.js";
import { lookupPlayerByPhone } from "../mcp/resaSquash.js";
import type { GraphDependencies } from "./dependencies.js";
import type { UnresolvedVoter } from "./state.js";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "./nodes/pollQuestion.js";
import { playerMessageName } from "@squash-assistant/db/playerLabel";
import type { Identities, PhotoVoter } from "@squash-assistant/db/rosterTypes";
import { normalizePhone, photoVoterKey } from "../roster/voteLedger.js";

export interface ResolvedVotes {
  /** Une entrée par heure candidate (même vide) — jamais undefined pour une heure de candidateStartTimes. */
  confirmedPlayerIdsByTime: Record<string, string[]>;
  /** Prête-noms volontaires cette semaine (option de sondage dédiée, ADR-017) — par job, pas par heure. */
  volunteerSubstituteIds: string[];
  unresolvedVoters: UnresolvedVoter[];
  /** userId → pseudo (`playerMessageName`) (lookup_player_by_phone) — seulement si resa-squash a renvoyé un nom. */
  voterNames: Record<string, string>;
}

/** Statut get_responses d'un membre qui n'a pas répondu (huddle-bot ADR-011). */
const NO_RESPONSE_STATUS = "aucune_reponse";

export interface VoteReading extends ResolvedVotes {
  /**
   * Membres ayant répondu quoi que ce soit (heure, prête-nom, « Non », ambigu…). 0 = lecture vide
   * suspecte : huddle-bot redémarré entre l'envoi et la collecte renvoie « aucune_reponse » pour tous.
   */
  respondentCount: number;
  /**
   * Photo du roster vivant : chaque répondant (« Non » compris, pour la règle de l'événement
   * périmé), avec téléphone normalisé et `votedAt`.
   */
  photoVoters: PhotoVoter[];
  /** Identités des seuls votants cherchés (heure ou prête-nom, P2-1) : jamais un « Non ». */
  identities: Identities;
}

/**
 * Lit les réponses au sondage (get_responses) et résout chaque votant en
 * userId resa-squash (lookup_player_by_phone), groupé par heure choisie
 * (statut = libellé exact de l'option votée, ex. "18H45" — huddle-bot
 * ADR-011). Les "Non" purs/ambigus/sans réponse ne rentrent dans aucun
 * groupe ; les "prête-nom volontaire" (ADR-017) sont résolus à part, jamais
 * comme joueurs confirmés. Appelé une seule fois par job, par le nœud
 * CollectVotes : un sondage legacy est supprimé juste après (spec 2026-10-09), toute
 * relecture renverrait « aucune_reponse » pour tous ; sinon la photo sert de base au
 * roster vivant (spec 2026-10-24-roster-desistements §4.2).
 */
export async function resolveVotes(
  deps: GraphDependencies,
  pollRequestId: string,
  candidateStartTimes: string[],
): Promise<VoteReading> {
  const { responses } = await getResponses(deps.huddleBot.client, pollRequestId);
  const respondentCount = responses.filter((r) => r.statut !== NO_RESPONSE_STATUS).length;
  const candidateSet = new Set(candidateStartTimes);

  const confirmedPlayerIdsByTime: Record<string, string[]> = {};
  for (const time of candidateStartTimes) {
    confirmedPlayerIdsByTime[time] = [];
  }
  const volunteerSubstituteIds: string[] = [];
  const unresolvedVoters: UnresolvedVoter[] = [];
  const voterNames: Record<string, string> = {};
  const photoVoters: PhotoVoter[] = [];
  const identities: Identities = {};

  for (const respondent of responses) {
    if (respondent.statut === NO_RESPONSE_STATUS) continue;
    const photoPhone = normalizePhone(respondent.phone);
    const key = photoVoterKey(photoPhone, respondent.member);
    photoVoters.push({ key, phone: photoPhone, waName: respondent.member, option: respondent.statut, votedAt: respondent.votedAt ?? null });

    const isCandidateTime = candidateSet.has(respondent.statut);
    const isSubstituteVolunteer = respondent.statut === SUBSTITUTE_VOLUNTEER_POLL_OPTION;
    if (!isCandidateTime && !isSubstituteVolunteer) continue;

    const phone = respondent.phone ? `+${respondent.phone}` : undefined;
    const lookup = phone ? await lookupPlayerByPhone(deps.resaSquash.client, phone) : { found: false as const };
    if (lookup.found && lookup.userId) {
      const name = playerMessageName(lookup);
      if (name) voterNames[lookup.userId] = name;
      identities[key] = { userId: lookup.userId, name: name || respondent.member };
      if (isSubstituteVolunteer) {
        volunteerSubstituteIds.push(lookup.userId);
      } else {
        confirmedPlayerIdsByTime[respondent.statut]!.push(lookup.userId);
      }
    } else {
      unresolvedVoters.push({ name: respondent.member, phone: phone ?? null, option: respondent.statut });
      identities[key] = { userId: null, name: respondent.member };
    }
  }

  return { confirmedPlayerIdsByTime, volunteerSubstituteIds, unresolvedVoters, voterNames, respondentCount, photoVoters, identities };
}
