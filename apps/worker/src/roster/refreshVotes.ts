import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type {
  Identities,
  RosterPlanSnapshot,
  VoteEventRow,
  VotePhoto,
  VoteState,
  VoterIdentity,
  VoterKey,
} from "@squash-assistant/db/rosterTypes";
import { playerMessageName } from "@squash-assistant/db/playerLabel";
import { lookupPlayerByPhone } from "../mcp/resaSquash.js";
import { sendTelegramMessage } from "../telegram/telegram.js";
import { buildUnresolvedVotersMessage, type UnresolvedVoterNotice } from "../graph/unresolvedVoters.js";
import type { GraphDependencies } from "../graph/dependencies.js";
import type { ResolvedVotes } from "../graph/resolveVotes.js";
import { listPollVoteEvents, mergeRosterIdentities } from "./rosterStore.js";
import { applyVoteEvents, eventVoterKey, photoState, toResolvedVotes, type ApplyResult } from "./voteLedger.js";

// Votes reçus après la collecte (spec 2026-10-24-roster-desistements §4.3, CA-2) : la photo est
// rejouée avec les événements de vote persistés par le listener, les votants nouveaux sont
// identifiés une seule fois (identités mémorisées sur le job).

type RefreshDeps = Pick<GraphDependencies, "db" | "resaSquash" | "telegram">;

const TEL_PREFIX = "tel:";

/** `event_id` déjà signalés sur Telegram (faux retrait, @lid non rapproché) : un message par événement, pas par passe. */
const notifiedEventIds = new Set<string>();

/** `<jobId>|<clé>` des votants tardifs non identifiés déjà signalés sur Telegram (B1-4) : un message par votant. */
const notifiedUnresolvedKeys = new Set<string>();

export function __resetRefreshVotesTelegramLogForTests(): void {
  notifiedEventIds.clear();
  notifiedUnresolvedKeys.clear();
}

/** Dernier `actorName` non vide des événements rattachés à chaque clé. */
function lastActorNames(events: VoteEventRow[], photo: VotePhoto): Record<VoterKey, string> {
  return events.reduce<Record<VoterKey, string>>((acc, event) => {
    const name = event.actorName?.trim();
    return name ? { ...acc, [eventVoterKey(event, photo).key]: name } : acc;
  }, {});
}

/** `lookupError` renseigné si la recherche a échoué (panne), absent si le numéro est simplement inconnu. */
async function lookupIdentity(
  deps: RefreshDeps,
  phone: string,
  fallbackName: string,
  ruleLabel: string,
): Promise<{ identity: VoterIdentity; lookupError?: string }> {
  try {
    const lookup = await lookupPlayerByPhone(deps.resaSquash.client, phone);
    if (!lookup.found || !lookup.userId) return { identity: { userId: null, name: fallbackName } };
    return { identity: { userId: lookup.userId, name: playerMessageName(lookup) || fallbackName } };
  } catch (err) {
    console.warn(`[refreshVotes] [${ruleLabel}] Recherche de ${fallbackName || phone} en échec :`, err);
    return { identity: { userId: null, name: fallbackName }, lookupError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Telegram best-effort (B1-4, décision du 2026-10-25) : votants tardifs à clé `tel:` restés non
 * identifiés, au format de la collecte, une seule fois par votant et par job. Les clés `nom:`/`jid:`
 * sont déjà signalées par `notifyVoteAnomalies`.
 */
async function notifyUnresolvedLateVoters(
  deps: RefreshDeps,
  jobId: string,
  ruleLabel: string,
  voters: Array<UnresolvedVoterNotice & { key: VoterKey }>,
): Promise<void> {
  const fresh = voters.filter((v) => !notifiedUnresolvedKeys.has(`${jobId}|${v.key}`));
  if (fresh.length === 0) return;
  try {
    await sendTelegramMessage(deps.telegram, buildUnresolvedVotersMessage(ruleLabel, fresh));
    fresh.forEach((v) => notifiedUnresolvedKeys.add(`${jobId}|${v.key}`));
  } catch (err) {
    console.error("[refreshVotes] Telegram non envoyé :", err);
  }
}

/**
 * Identités des votants qui jouent (option non nulle) sans identité connue — un « Non » de la photo
 * qui revote compris (P2-1). Clé `tel:` : un seul `lookup_player_by_phone`, repli sur le nom (jamais le téléphone) ; clé
 * `nom:`/`jid:` : nom seul, sans recherche (PC2-2). Fusion `keep` : une identification déjà en base
 * (« Recalculer », R1-4) n'est jamais écrasée. Renvoie les identités complétées.
 */
export async function resolveNewIdentities(
  deps: RefreshDeps,
  job: JobRun,
  photo: VotePhoto,
  state: VoteState,
  events: VoteEventRow[],
  identities: Identities,
  ruleLabel: string,
): Promise<Identities> {
  const newKeys = Object.keys(state).filter((key) => state[key]!.option !== null && !identities[key]);
  if (newKeys.length === 0) return identities;

  const actorNames = lastActorNames(events, photo);
  const waNames = Object.fromEntries(photo.voters.map((v) => [v.key, v.waName]));
  const patch: Identities = {};
  const unresolved: Array<UnresolvedVoterNotice & { key: VoterKey }> = [];
  for (const key of newKeys) {
    if (key.startsWith(TEL_PREFIX)) {
      const phone = key.slice(TEL_PREFIX.length);
      // Jamais le téléphone comme nom (B1-1) : il finirait affiché sur WhatsApp.
      const { identity, lookupError } = await lookupIdentity(deps, phone, actorNames[key] ?? waNames[key] ?? "", ruleLabel);
      patch[key] = identity;
      if (!identity.userId) {
        unresolved.push({ key, name: identity.name || "nom inconnu", phone, option: state[key]!.option!, lookupError });
      }
    } else {
      patch[key] = { userId: null, name: waNames[key] ?? actorNames[key] ?? "" };
    }
  }
  await mergeRosterIdentities(deps.db, job.id, patch, "keep");
  await notifyUnresolvedLateVoters(deps, job.id, ruleLabel, unresolved);
  return { ...patch, ...identities };
}

function voterLabel(event: VoteEventRow): string {
  return `${event.actorName?.trim() || "nom inconnu"} (${event.actorJid})`;
}

/** Telegram best-effort, une fois par `event_id` : le détail technique (JID) n'y est montré qu'à l'organisateur. */
export async function notifyVoteAnomalies(deps: RefreshDeps, ruleLabel: string, applied: ApplyResult): Promise<void> {
  const messages = [
    ...applied.suspiciousDeletions.map((e) => ({
      eventId: e.eventId,
      text: `[${ruleLabel}] ⚠️ Retrait de vote suspect ignoré (aucune option avant ni après) : ${voterLabel(e)}, événement ${e.eventId}.`,
    })),
    ...applied.unmatchedNoPhone.map((e) => ({
      eventId: e.eventId,
      text: `[${ruleLabel}] ⚠️ Vote sans numéro, non rapproché d'un votant connu : ${voterLabel(e)} — compté sous son JID, événement ${e.eventId}.`,
    })),
  ];
  for (const { eventId, text } of messages) {
    if (notifiedEventIds.has(eventId)) continue;
    try {
      await sendTelegramMessage(deps.telegram, text);
      notifiedEventIds.add(eventId);
    } catch (err) {
      console.error("[refreshVotes] Telegram non envoyé :", err);
    }
  }
}

/**
 * Votes à jour pour le plan : photo de la collecte + événements de vote arrivés depuis. null pour un
 * job legacy (pas de photo). Le snapshot `T_plan` est à enregistrer par l'appelant une fois le plan calculé.
 */
export async function refreshVotesFromEvents(
  deps: RefreshDeps,
  job: JobRun,
  rule: BookingRule,
  ruleLabel: string,
  now: Date = new Date(),
): Promise<{ resolved: ResolvedVotes; snapshot: RosterPlanSnapshot } | null> {
  const photo = job.rosterPhoto;
  if (!photo || !job.pollMsgId) return null;
  const { candidateStartTimes } = rule;

  const events = await listPollVoteEvents(deps.db, { chatJid: rule.whatsappGroupJid, pollMsgId: job.pollMsgId });
  const applied = applyVoteEvents(photo, events, candidateStartTimes, {
    state: photoState(photo, candidateStartTimes),
    integratedEventIds: photo.integratedEventIds,
  });
  const identities = await resolveNewIdentities(deps, job, photo, applied.state, events, job.rosterIdentities ?? {}, ruleLabel);
  await notifyVoteAnomalies(deps, ruleLabel, applied);

  return {
    resolved: toResolvedVotes(applied.state, identities, candidateStartTimes),
    snapshot: { tPlan: now.toISOString(), state: applied.state, integratedEventIds: applied.integratedEventIds },
  };
}
