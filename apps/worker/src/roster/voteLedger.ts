import type {
  Identities,
  VoteEventRow,
  VotePhoto,
  VoteState,
  VoterKey,
} from "@squash-assistant/db/rosterTypes";
import type { ResolvedVotes } from "../graph/resolveVotes.js";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "../graph/nodes/pollQuestion.js";

const POLL_VOTE_EVENT_PREFIX = "poll_vote_";
const TEL_PREFIX = "tel:";

export interface ApplyResult {
  state: VoteState;
  /** Événements effectivement appliqués, dans l'ordre reçu. */
  applied: Array<{ eventId: string; key: VoterKey; option: string | null }>;
  /** `from.integratedEventIds` ∪ ids des événements `poll_vote_*` reçus (appliqués, périmés ou suspects). */
  integratedEventIds: string[];
  /** `selectedOptions` et `previousOptions` vides, votant avec une option au registre : retrait appliqué (R2-16). */
  emptyRetractions: Array<{ event: VoteEventRow; previousOption: string }>;
  /** Votant sans téléphone ni nom rapproché, compté sous son JID (C1-4) : événements appliqués seulement. */
  unmatchedNoPhone: VoteEventRow[];
}

/** Garde les chiffres et préfixe `+` ; null s'il n'en reste aucun. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits === "" ? null : `+${digits}`;
}

export function photoVoterKey(phone: string | null, waName: string): VoterKey {
  const normalized = normalizePhone(phone);
  return normalized ? `${TEL_PREFIX}${normalized}` : `nom:${waName}`;
}

/** Heure candidate ou prête-nom → conservée ; « Non » et tout le reste → null (ne joue pas). */
function normalizeOption(option: string | undefined, candidateStartTimes: string[]): string | null {
  if (option === undefined) return null;
  if (option === SUBSTITUTE_VOLUNTEER_POLL_OPTION || candidateStartTimes.includes(option)) return option;
  return null;
}

export function photoState(photo: VotePhoto, candidateStartTimes: string[]): VoteState {
  return Object.fromEntries(
    photo.voters.map((v) => [v.key, { option: normalizeOption(v.option, candidateStartTimes), lastAt: v.votedAt }]),
  );
}

export function eventVoterKey(
  event: VoteEventRow,
  photo: VotePhoto,
): { key: VoterKey; matchedBy: "phone" | "name" | "jid" } {
  const phone = normalizePhone(event.actorPhone);
  const name = event.actorName?.trim();
  const sameName = (v: VotePhoto["voters"][number]): boolean => Boolean(name) && v.waName.trim() === name;
  if (phone) {
    const key: VoterKey = `${TEL_PREFIX}${phone}`;
    // Téléphone absent de la photo : un votant de la photo sans téléphone, même nom, est le même
    // joueur (B1-2) — sinon il serait compté deux fois (clé nom: inscrite + clé tel: nouvelle).
    const byNameNoPhone = photo.voters.some((v) => v.key === key)
      ? undefined
      : photo.voters.find((v) => v.phone === null && sameName(v));
    return byNameNoPhone ? { key: byNameNoPhone.key, matchedBy: "name" } : { key, matchedBy: "phone" };
  }
  const byName = photo.voters.find(sameName);
  if (byName) return { key: byName.key, matchedBy: "name" };
  return { key: `jid:${event.actorJid}`, matchedBy: "jid" };
}

export function applyVoteEvents(
  photo: VotePhoto,
  events: VoteEventRow[],
  candidateStartTimes: string[],
  from: { state: VoteState; integratedEventIds: string[] },
): ApplyResult {
  const alreadyIntegrated = new Set(from.integratedEventIds);
  const integrated = new Set(from.integratedEventIds);
  const applied: ApplyResult["applied"] = [];
  const emptyRetractions: ApplyResult["emptyRetractions"] = [];
  const unmatchedNoPhone: VoteEventRow[] = [];
  let state: VoteState = { ...from.state };

  for (const event of events) {
    if (!event.eventType.startsWith(POLL_VOTE_EVENT_PREFIX)) continue;
    if (alreadyIntegrated.has(event.eventId)) continue;
    integrated.add(event.eventId);

    const { key, matchedBy } = eventVoterKey(event, photo);
    const occurredAt = event.occurredAt.getTime();
    const lastAt = state[key]?.lastAt ?? null;
    if (lastAt !== null && occurredAt <= lastAt) continue; // périmé : déjà reflété

    // Retrait sans aucune option, avant ni après : retrait réel si le registre connaît une option (R2-16).
    const isEmptyRetraction = event.selectedOptions.length === 0 && event.previousOptions.length === 0;
    if (isEmptyRetraction) {
      const previousOption = state[key]?.option ?? null;
      if (previousOption === null) continue; // rien à retirer
      emptyRetractions.push({ event, previousOption });
    }
    if (matchedBy === "jid") unmatchedNoPhone.push(event);

    const option = normalizeOption(event.selectedOptions[0], candidateStartTimes);
    state = { ...state, [key]: { option, lastAt: occurredAt } };
    applied.push({ eventId: event.eventId, key, option });
  }

  return { state, applied, integratedEventIds: [...integrated], emptyRetractions, unmatchedNoPhone };
}

export function toResolvedVotes(
  state: VoteState,
  identities: Identities,
  candidateStartTimes: string[],
): ResolvedVotes {
  const confirmedPlayerIdsByTime: Record<string, string[]> = Object.fromEntries(
    candidateStartTimes.map((time) => [time, [] as string[]]),
  );
  const volunteerSubstituteIds: string[] = [];
  const unresolvedVoters: ResolvedVotes["unresolvedVoters"] = [];
  const voterNames: Record<string, string> = {};

  for (const [key, vote] of Object.entries(state)) {
    const option = vote.option;
    if (option === null) continue;
    const identity = identities[key] ?? { userId: null, name: "" };
    if (!identity.userId) {
      const phone = key.startsWith(TEL_PREFIX) ? key.slice(TEL_PREFIX.length) : null;
      unresolvedVoters.push({ name: identity.name, phone, option });
      continue;
    }
    voterNames[identity.userId] = identity.name;
    if (option === SUBSTITUTE_VOLUNTEER_POLL_OPTION) volunteerSubstituteIds.push(identity.userId);
    else confirmedPlayerIdsByTime[option]?.push(identity.userId);
  }
  return { confirmedPlayerIdsByTime, volunteerSubstituteIds, unresolvedVoters, voterNames };
}
