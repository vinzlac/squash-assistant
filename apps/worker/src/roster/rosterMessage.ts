import { createHash } from "node:crypto";
import type { Identities, RosterFinal, VoteState, VoterKey } from "@squash-assistant/db/rosterTypes";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION, formatInformalDate, formatSessionTime } from "../graph/nodes/pollQuestion.js";
import { UNKNOWN_PLAYER_LABEL, joinFrench, publicVoterName } from "../graph/nodes/registrationRecap.js";
import { initialRosters, seatedKeys, type HourRoster, type SeatSlot } from "./allocation.js";

const PROVISIONAL_SOON = "Les courts arrivent bientôt 😉";
const FINAL_CHANGE_HOUR = "Changer d'heure = repasser en attente si l'heure est pleine.";
const WITHDRAW_HINT = "Pour te désister, retire ton vote dans le sondage 🙏";

/**
 * Nom affiché sur WhatsApp : jamais de téléphone ni de JID (les noms d'un non-identifié passent par
 * `publicVoterName`). Sans identité connue : « un joueur ».
 */
export function rosterDisplayName(key: VoterKey, identities: Identities): string {
  const identity = identities[key];
  if (!identity) return UNKNOWN_PLAYER_LABEL;
  return identity.userId === null ? publicVoterName(identity.name) : identity.name;
}

/** Roster provisoire (spec §4.4) : tous les votants d'une heure sont inscrits, par `lastAt` croissant. */
export function buildProvisionalRosterMessage(input: {
  targetDate: string;
  candidateStartTimes: string[];
  state: VoteState;
  identities: Identities;
}): string {
  const { targetDate, candidateStartTimes, state, identities } = input;
  const name = (key: VoterKey): string => rosterDisplayName(key, identities);
  const date = formatInformalDate(targetDate);
  const voterCount = (time: string): number => Object.values(state).filter((v) => v.option === time).length;
  const rosters = initialRosters(
    candidateStartTimes.map((time) => ({ time, capacity: voterCount(time) })),
    state,
    name,
  );
  const timeLines = rosters
    .map((roster) => ({ roster, names: seatedKeys(roster).map(name) }))
    .filter(({ names }) => names.length > 0)
    .map(({ roster, names }) => `⏰ ${formatSessionTime(roster.time)} (${names.length}) : ${names.join(", ")}`);

  if (timeLines.length === 0) return `📋 Inscrits — ${date}\nPersonne pour l'instant 😢`;

  // Comme le récap actuel : d'abord les identifiés, puis les non identifiés, chacun par ordre d'arrivée.
  const volunteerKeys = Object.entries(state)
    .filter(([, vote]) => vote.option === SUBSTITUTE_VOLUNTEER_POLL_OPTION)
    .sort(([, a], [, b]) => (a.lastAt ?? Infinity) - (b.lastAt ?? Infinity))
    .map(([key]) => key);
  const isIdentified = (key: VoterKey): boolean => identities[key]?.userId != null;
  const volunteers = [...volunteerKeys.filter(isIdentified), ...volunteerKeys.filter((k) => !isIdentified(k))].map(name);
  const thanks =
    volunteers.length === 0
      ? []
      : [`🙏 Merci à ${joinFrench(volunteers)} pour ${volunteers.length === 1 ? "le prête-nom" : "les prête-noms"} :)`];

  return [`📋 Inscrits — ${date} 🎾`, ...timeLines, ...thanks, PROVISIONAL_SOON, WITHDRAW_HINT].join("\n");
}

function freePlacesLabel(count: number): string {
  return `${count} ${count >= 2 ? "places libres" : "place libre"}`;
}

type SeatedSlot = SeatSlot & { key: VoterKey };

function isSeated(slot: SeatSlot): slot is SeatedSlot {
  return slot.key !== null;
}

function seatedName(slot: SeatedSlot, identities: Identities): string {
  const name = rosterDisplayName(slot.key, identities);
  return slot.replaces === null ? name : `${name} (remplace ${rosterDisplayName(slot.replaces, identities)})`;
}

function finalHourLines(roster: HourRoster, identities: Identities): string[] {
  const hour = formatSessionTime(roster.time);
  const seated = roster.slots.filter(isSeated);
  const free = roster.capacity - seated.length;
  const waiting = roster.waiting.length > 0
    ? [`⏳ En attente ${hour} : ${roster.waiting.map((k) => rosterDisplayName(k, identities)).join(", ")}`]
    : [];

  if (roster.capacity === 0) return roster.waiting.length > 0 ? [`⏰ ${hour} : pas de court réservé`, ...waiting] : [];
  if (seated.length === 0) return [`⏰ ${hour} (0/${roster.capacity}) — ${freePlacesLabel(free)}`, ...waiting];
  const names = seated.map((slot) => seatedName(slot, identities)).join(", ");
  const suffix = free > 0 ? ` — ${freePlacesLabel(free)}` : "";
  return [`⏰ ${hour} (${seated.length}/${roster.capacity}) : ${names}${suffix}`, ...waiting];
}

/** Roster définitif (spec §4.5) : titre, courts, inscrits et attente par heure, notes, pied. */
export function buildFinalRosterMessage(input: {
  final: RosterFinal;
  targetDate: string;
  rosters: HourRoster[];
  identities: Identities;
  candidateStartTimes: string[];
}): string {
  const { final, targetDate, rosters, identities, candidateStartTimes } = input;
  const rank = (time: string): number => {
    const index = candidateStartTimes.indexOf(time);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index; // heure inconnue : en dernier
  };
  const ordered = [...rosters].sort((a, b) => rank(a.time) - rank(b.time));
  return [
    final.title,
    "",
    `📅 ${targetDate}`,
    "",
    final.courtsBlock,
    "",
    ...ordered.flatMap((roster) => finalHourLines(roster, identities)),
    ...[final.failuresNote, final.capacityNote].map((note) => note.replace(/^\n+/, "")).filter((note) => note !== ""),
    "",
    FINAL_CHANGE_HOUR,
    WITHDRAW_HINT,
  ].join("\n");
}

/** Empreinte du texte publié : détecte qu'un message a changé (sha256 hex). */
export function rosterFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Noms des inscrits (places occupées) par heure, dans l'ordre des places. */
export function rosterInscritsByTime(rosters: HourRoster[], identities: Identities): Record<string, string[]> {
  return Object.fromEntries(
    rosters.map((roster) => [roster.time, seatedKeys(roster).map((key) => rosterDisplayName(key, identities))]),
  );
}
