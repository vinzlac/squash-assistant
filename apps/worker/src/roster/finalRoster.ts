import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { HourCapacity, Identities, RosterFinal, RosterPlanSnapshot } from "@squash-assistant/db/rosterTypes";
import type { GraphDependencies } from "../graph/dependencies.js";
import type { BookingPlanGroup, ReservationFailure } from "../graph/state.js";
import { reservedBookings } from "../graph/unbookedPlayers.js";
import { applyMoves, initialRosters, type HourRoster } from "./allocation.js";
import { publishRoster, type RosterPhase } from "./publishRoster.js";
import { notifyVoteAnomalies, resolveNewIdentities } from "./refreshVotes.js";
import { buildFinalRosterMessage, buildProvisionalRosterMessage, rosterDisplayName } from "./rosterMessage.js";
import { listPollVoteEvents, saveRosterFinal } from "./rosterStore.js";
import { applyVoteEvents, photoState } from "./voteLedger.js";

// Roster définitif (spec 2026-10-24-roster-desistements §4.5, CA-3) : à la réservation, l'annonce
// des courts devient le roster ; il est ensuite recalculé depuis sa base figée (`RosterFinal.base`)
// et les événements de vote, jamais depuis le dernier texte publié.

type LiveDeps = Pick<GraphDependencies, "db" | "resaSquash" | "telegram">;

export interface LiveRosters {
  text: string;
  phase: RosterPhase;
  rosters: HourRoster[];
  identities: Identities;
}

/**
 * Base du roster définitif. Par heure candidate ayant au moins un « oui » au plan : capacité = nombre
 * de « oui » si le groupe du plan de cette heure a au moins une ligne réellement prise (ni refusée,
 * ni hors fenêtre), sinon 0 — refus total ou votants tous déplacés (R1-5).
 */
export function buildRosterFinal(input: {
  snapshot: RosterPlanSnapshot;
  groups: BookingPlanGroup[];
  failures: ReservationFailure[];
  candidateStartTimes: string[];
  realBooking: boolean;
  title: string;
  courtsBlock: string;
  failuresNote: string;
  capacityNote: string;
}): RosterFinal {
  const { snapshot, groups, failures, candidateStartTimes, realBooking, title, courtsBlock, failuresNote, capacityNote } = input;
  const yesCount = (time: string): number => Object.values(snapshot.state).filter((v) => v.option === time).length;
  const hasReserved = (time: string): boolean =>
    reservedBookings(groups.filter((g) => g.startTime === time), failures).length > 0;
  const hours: HourCapacity[] = candidateStartTimes
    .filter((time) => yesCount(time) > 0)
    .map((time) => ({ time, capacity: hasReserved(time) ? yesCount(time) : 0 }));
  return { base: snapshot, hours, realBooking, title, courtsBlock, failuresNote, capacityNote };
}

/**
 * Texte vivant du roster d'un job. `rule` est la copie de la règle prise par le job (groupe du
 * sondage) ; la règle live ne sert qu'au libellé (P1-9). Avec un `RosterFinal` (option ou job) :
 * roster définitif rejoué depuis sa base, déterministe pour les mêmes événements. Sinon : roster
 * provisoire (photo + événements). null pour un job legacy (pas de photo).
 */
export async function computeLiveRosters(
  deps: LiveDeps,
  job: JobRun,
  rule: BookingRule,
  ruleLabel: string,
  opts: { final?: RosterFinal } = {},
): Promise<LiveRosters | null> {
  const photo = job.rosterPhoto;
  if (!photo) return null;
  const candidateStartTimes = job.candidateStartTimes ?? rule.candidateStartTimes;
  const final = opts.final ?? job.rosterFinal ?? null;

  const events = job.pollMsgId
    ? await listPollVoteEvents(deps.db, { chatJid: rule.whatsappGroupJid, pollMsgId: job.pollMsgId })
    : [];
  const from = final
    ? { state: final.base.state, integratedEventIds: final.base.integratedEventIds }
    : { state: photoState(photo, candidateStartTimes), integratedEventIds: photo.integratedEventIds };
  const applied = applyVoteEvents(photo, events, candidateStartTimes, from);
  const identities = await resolveNewIdentities(deps, job, photo, applied.state, events, job.rosterIdentities ?? {}, ruleLabel);
  await notifyVoteAnomalies(deps, job.id, ruleLabel, applied);

  if (!final) {
    const text = buildProvisionalRosterMessage({ targetDate: job.targetDate, candidateStartTimes, state: applied.state, identities });
    return { text, phase: "provisional", rosters: [], identities };
  }

  const rosters = applyMoves(
    initialRosters(final.hours, final.base.state, (key) => rosterDisplayName(key, identities)),
    applied.applied.map(({ key, option }) => ({ key, option })),
    candidateStartTimes,
  );
  const text = buildFinalRosterMessage({ final, targetDate: job.targetDate, rosters, identities, candidateStartTimes });
  return { text, phase: "final", rosters, identities };
}

/**
 * Étape 4 en mode roster : enregistre la base du roster définitif puis le publie à la place de
 * l'annonce (il remplace le provisoire). Ni `"busy"` ni `"failed"` ne lèvent : la base est déjà
 * enregistrée et le tick republie le définitif ; sur `"failed"`, Telegram à l'organisateur (par
 * publishRoster) et l'étape continue (QR, synthèse, fin `finished-announced`) — B1-8, décision de Vinz
 * du 2026-10-25. Renvoie le texte du roster (publié ou à republier) et s'il est parti (B2-5).
 */
export async function publishFinalRoster(input: {
  deps: GraphDependencies;
  job: JobRun;
  snapshot: RosterPlanSnapshot;
  rule: BookingRule;
  ruleLabel: string;
  notifyJid: string;
  groups: BookingPlanGroup[];
  failures: ReservationFailure[];
  realBooking: boolean;
  title: string;
  courtsBlock: string;
  failuresNote: string;
  capacityNote: string;
}): Promise<{ text: string; sent: boolean }> {
  const { deps, job, snapshot, rule, ruleLabel, notifyJid, groups, failures, realBooking, title, courtsBlock, failuresNote, capacityNote } = input;
  const final = buildRosterFinal({
    snapshot,
    groups,
    failures,
    candidateStartTimes: job.candidateStartTimes ?? rule.candidateStartTimes,
    realBooking,
    title,
    courtsBlock,
    failuresNote,
    capacityNote,
  });
  await saveRosterFinal(deps.db, job.id, final);

  const live = await computeLiveRosters(deps, job, rule, ruleLabel, { final });
  if (!live) throw new Error("Roster définitif impossible : photo des votes absente du job.");
  const outcome = await publishRoster(
    { deps, job, ruleLabel, pinEnabled: rule.pinMessagesEnabled, notifyJid, now: new Date() },
    live.text,
    "final",
  );
  // Le Telegram de l'échec est envoyé par publishRoster (un seul message, B2-5).
  return { text: live.text, sent: outcome === "published" || outcome === "unchanged" };
}
