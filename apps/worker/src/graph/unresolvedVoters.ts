import type { McpConnection } from "../mcp/client.js";
import { lookupPlayerByPhone } from "../mcp/resaSquash.js";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "./nodes/pollQuestion.js";
import type { UnresolvedVoter } from "./state.js";

function describeCause(voter: UnresolvedVoter): string {
  return voter.phone ? `${voter.phone}, numéro inconnu de resa-squash` : "pas de numéro WhatsApp";
}

/** Message Telegram (organisateur) envoyé à la collecte dès qu'un votant n'est pas identifié (spec 2026-10-09 §3.1). */
export function buildUnresolvedVotersMessage(ruleLabel: string, voters: UnresolvedVoter[]): string {
  const lines = voters.map((v) => `  • ${v.name} (${describeCause(v)}) — « ${v.option} »`);
  return (
    `[${ruleLabel}] ⚠️ ${voters.length} votant(s) non identifié(s) — impossible de savoir qui c'est, exclu(s) du plan :\n` +
    `${lines.join("\n")}\n` +
    "→ Associer ce numéro à leur compte TeamR/resa-squash, puis « Recalculer le plan » avant le go."
  );
}

export interface VotesSnapshot {
  confirmedPlayerIdsByTime: Record<string, string[]>;
  volunteerSubstituteIds: string[];
  unresolvedVoters: UnresolvedVoter[];
  /** userId → « Prénom Nom » (lookup_player_by_phone), complété pour chaque votant ajouté au plan. */
  voterNames: Record<string, string>;
}

export interface RelookupResult extends VotesSnapshot {
  identified: Array<{ name: string; option: string }>;
  /** Retrouvé, mais son option n'est plus une heure du job : non ajouté au plan, conservé dans unresolvedVoters. */
  identifiedUnknownOption: Array<{ name: string; option: string }>;
  stillUnknown: string[];
}

async function lookupPlayer(resaSquash: McpConnection, phone: string): Promise<{ userId: string; fullName: string } | null> {
  try {
    const lookup = await lookupPlayerByPhone(resaSquash.client, phone);
    if (!lookup.found || !lookup.userId) return null;
    return { userId: lookup.userId, fullName: `${lookup.firstName ?? ""} ${lookup.lastName ?? ""}`.trim() };
  } catch {
    return null;
  }
}

/**
 * « Recalculer le plan » (spec 2026-10-09 §3.3) : relance `lookup_player_by_phone` pour chaque
 * votant non identifié qui a un téléphone (le sondage est fermé, on ne le relit pas). Identifié →
 * ajouté à son heure ou aux prête-noms, et son nom à `voterNames` ; option qui n'est plus une heure
 * du job → signalé à part, conservé ; toujours inconnu ou sans téléphone → conservé.
 */
export async function relookupUnresolvedVoters(resaSquash: McpConnection, votes: VotesSnapshot): Promise<RelookupResult> {
  const confirmedPlayerIdsByTime = Object.fromEntries(
    Object.entries(votes.confirmedPlayerIdsByTime).map(([time, ids]) => [time, [...ids]]),
  );
  const volunteerSubstituteIds = [...votes.volunteerSubstituteIds];
  const voterNames = { ...votes.voterNames };
  const unresolvedVoters: UnresolvedVoter[] = [];
  const identified: RelookupResult["identified"] = [];
  const identifiedUnknownOption: RelookupResult["identifiedUnknownOption"] = [];
  const stillUnknown: string[] = [];

  for (const voter of votes.unresolvedVoters) {
    if (!voter.phone) {
      unresolvedVoters.push(voter);
      continue;
    }
    const player = await lookupPlayer(resaSquash, voter.phone);
    if (!player) {
      unresolvedVoters.push(voter);
      stillUnknown.push(voter.name);
      continue;
    }
    const target =
      voter.option === SUBSTITUTE_VOLUNTEER_POLL_OPTION ? volunteerSubstituteIds : confirmedPlayerIdsByTime[voter.option];
    if (!target) {
      unresolvedVoters.push(voter);
      identifiedUnknownOption.push({ name: voter.name, option: voter.option });
      continue;
    }
    if (!target.includes(player.userId)) target.push(player.userId);
    if (player.fullName) voterNames[player.userId] = player.fullName;
    identified.push({ name: voter.name, option: voter.option });
  }

  return { confirmedPlayerIdsByTime, volunteerSubstituteIds, unresolvedVoters, voterNames, identified, identifiedUnknownOption, stillUnknown };
}

/** « [règle] Recalcul : Vince identifié (prête-nom), Thomas LECCIA toujours inconnu » ; null si personne n'a été recherché. */
export function formatRelookupSummary(ruleLabel: string, result: RelookupResult): string | null {
  const parts = [
    ...result.identified.map((v) => `${v.name} identifié (${v.option === SUBSTITUTE_VOLUNTEER_POLL_OPTION ? "prête-nom" : v.option})`),
    ...result.identifiedUnknownOption.map((v) => `${v.name} identifié mais option inconnue (« ${v.option} »)`),
    ...result.stillUnknown.map((name) => `${name} toujours inconnu`),
  ];
  return parts.length === 0 ? null : `[${ruleLabel}] Recalcul : ${parts.join(", ")}`;
}
