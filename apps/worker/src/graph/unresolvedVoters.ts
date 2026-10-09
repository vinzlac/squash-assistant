import type { McpConnection } from "../mcp/client.js";
import { lookupPlayerByPhone } from "../mcp/resaSquash.js";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "./nodes/pollQuestion.js";
import type { UnresolvedVoter } from "./state.js";
import { playerMessageName } from "@squash-assistant/db/playerLabel";

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
  /** Recherche en échec (panne resa-squash) : on ne sait pas si le numéro est connu ; conservé dans unresolvedVoters. */
  lookupFailed: Array<{ name: string; error: string }>;
}

type LookupOutcome =
  | { kind: "found"; userId: string; name: string }
  | { kind: "unknown" }
  | { kind: "failed"; error: unknown };

async function lookupPlayer(resaSquash: McpConnection, phone: string): Promise<LookupOutcome> {
  try {
    const lookup = await lookupPlayerByPhone(resaSquash.client, phone);
    if (!lookup.found || !lookup.userId) return { kind: "unknown" };
    return { kind: "found", userId: lookup.userId, name: playerMessageName(lookup) };
  } catch (error) {
    return { kind: "failed", error };
  }
}

/**
 * « Recalculer le plan » (spec 2026-10-09 §3.3) : relance `lookup_player_by_phone` pour chaque
 * votant non identifié qui a un téléphone (le sondage est fermé, on ne le relit pas). Identifié →
 * ajouté à son heure ou aux prête-noms, et son nom à `voterNames` ; option qui n'est plus une heure
 * du job → signalé à part, conservé ; toujours inconnu, recherche en échec ou sans téléphone → conservé
 * (une panne de resa-squash ne bloque pas le recalcul).
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
  const lookupFailed: RelookupResult["lookupFailed"] = [];

  for (const voter of votes.unresolvedVoters) {
    if (!voter.phone) {
      unresolvedVoters.push(voter);
      continue;
    }
    const player = await lookupPlayer(resaSquash, voter.phone);
    if (player.kind === "failed") {
      console.warn(`[relookupUnresolvedVoters] Recherche de ${voter.name} en échec :`, player.error);
      unresolvedVoters.push(voter);
      lookupFailed.push({ name: voter.name, error: player.error instanceof Error ? player.error.message : String(player.error) });
      continue;
    }
    if (player.kind === "unknown") {
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
    if (player.name) voterNames[player.userId] = player.name;
    identified.push({ name: voter.name, option: voter.option });
  }

  return { confirmedPlayerIdsByTime, volunteerSubstituteIds, unresolvedVoters, voterNames, identified, identifiedUnknownOption, stillUnknown, lookupFailed };
}

/** « [règle] Recalcul : Vince identifié (prête-nom), Thomas LECCIA toujours inconnu » ; null si personne n'a été recherché. */
export function formatRelookupSummary(ruleLabel: string, result: RelookupResult): string | null {
  const parts = [
    ...result.identified.map((v) => `${v.name} identifié (${v.option === SUBSTITUTE_VOLUNTEER_POLL_OPTION ? "prête-nom" : v.option})`),
    ...result.identifiedUnknownOption.map((v) => `${v.name} identifié mais option inconnue (« ${v.option} »)`),
    ...result.stillUnknown.map((name) => `${name} toujours inconnu`),
    ...result.lookupFailed.map((v) => `${v.name} recherche en échec (${v.error})`),
  ];
  return parts.length === 0 ? null : `[${ruleLabel}] Recalcul : ${parts.join(", ")}`;
}
