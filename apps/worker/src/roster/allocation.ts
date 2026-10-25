import type { HourCapacity, VoteState, VoterKey } from "@squash-assistant/db/rosterTypes";

/** Une place : occupée (`key`), ou libre (`key` null) avec mémoire de qui l'a libérée. */
export interface SeatSlot {
  key: VoterKey | null;
  /** Prédécesseur immédiat quand la place a été reprise après un désistement. */
  replaces: VoterKey | null;
  /** Place libre : qui l'a libérée. */
  freedBy: VoterKey | null;
  /** Place libre : rang de libération (le plus petit = le plus ancien). */
  freedSeq: number | null;
}
export interface HourRoster { time: string; capacity: number; slots: SeatSlot[]; waiting: VoterKey[] }

const TEL_PREFIX = "tel:";

function phoneOf(key: VoterKey): number | null {
  if (!key.startsWith(TEL_PREFIX)) return null;
  const digits = key.slice(TEL_PREFIX.length).replace(/\D/g, "");
  return digits === "" ? null : Number(digits);
}

/** Comparaison croissante, valeur nulle en dernier. */
function compareNullLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function emptySeat(): SeatSlot {
  return { key: null, replaces: null, freedBy: null, freedSeq: null };
}

function occupied(key: VoterKey): SeatSlot {
  return { key, replaces: null, freedBy: null, freedSeq: null };
}

/**
 * Roster de départ : par heure, les votants triés (spec §4.5, P1-17) ; les `capacity` premiers sont inscrits.
 * Invariant attendu : capacity ≤ nombre de votants de l'heure dans `state`. Si capacity est plus grand,
 * l'écart est complété par des slots libres sans mémoire (key, freedBy, freedSeq à null).
 */
export function initialRosters(
  hours: HourCapacity[],
  state: VoteState,
  displayName: (key: VoterKey) => string,
): HourRoster[] {
  return hours.map(({ time, capacity }) => {
    const ordered = Object.entries(state)
      .filter(([, vote]) => vote.option === time)
      .sort(
        ([ka, a], [kb, b]) =>
          compareNullLast(a.lastAt, b.lastAt) ||
          compareNullLast(phoneOf(ka), phoneOf(kb)) ||
          displayName(ka).localeCompare(displayName(kb), "fr"),
      )
      .map(([key]) => key);
    return {
      time,
      capacity,
      slots: [
        ...ordered.slice(0, capacity).map(occupied),
        ...Array.from({ length: Math.max(0, capacity - ordered.length) }, () => emptySeat()),
      ],
      waiting: ordered.slice(capacity),
    };
  });
}

/** Clés des inscrits (places occupées), dans l'ordre des places. */
export function seatedKeys(roster: HourRoster): VoterKey[] {
  return roster.slots.flatMap((slot) => (slot.key === null ? [] : [slot.key]));
}

function nextFreedSeq(rosters: HourRoster[]): number {
  const seqs = rosters.flatMap((r) => r.slots.map((s) => s.freedSeq ?? -1));
  return Math.max(-1, ...seqs) + 1;
}

/** Retire `key` de son heure (inscrit ou en attente) : règle 1. */
function withdraw(rosters: HourRoster[], key: VoterKey): HourRoster[] {
  const seq = nextFreedSeq(rosters);
  return rosters.map((roster) => {
    if (roster.waiting.includes(key)) {
      return { ...roster, waiting: roster.waiting.filter((k) => k !== key) };
    }
    const index = roster.slots.findIndex((s) => s.key === key);
    if (index < 0) return roster;
    const [next, ...rest] = roster.waiting;
    const slot: SeatSlot = next === undefined
      ? { key: null, replaces: null, freedBy: key, freedSeq: seq }
      : { key: next, replaces: key, freedBy: null, freedSeq: null };
    return {
      ...roster,
      slots: roster.slots.map((s, i) => (i === index ? slot : s)),
      waiting: next === undefined ? roster.waiting : rest,
    };
  });
}

/** Insère une heure vide (capacity 0) avant la première heure qui la suit dans l'ordre des candidats. */
function insertHour(rosters: HourRoster[], time: string, candidates: string[]): HourRoster[] {
  const rank = candidates.indexOf(time);
  const at = rosters.findIndex((r) => candidates.indexOf(r.time) > rank);
  const created: HourRoster = { time, capacity: 0, slots: [], waiting: [] };
  return at < 0 ? [...rosters, created] : [...rosters.slice(0, at), created, ...rosters.slice(at)];
}

/** Fait entrer `key` à l'heure `time` : règle 2 (créée à la volée avec capacité 0 si absente). */
function enter(rosters: HourRoster[], key: VoterKey, time: string, candidates: string[]): HourRoster[] {
  const base = rosters.some((r) => r.time === time) ? rosters : insertHour(rosters, time, candidates);
  return base.map((roster) => {
    if (roster.time !== time) return roster;
    const free = roster.slots.flatMap((s, i) => (s.key === null ? [{ s, i }] : []));
    const own = free.find(({ s }) => s.freedBy === key);
    const oldest = [...free].sort((a, b) => (a.s.freedSeq ?? 0) - (b.s.freedSeq ?? 0))[0];
    const chosen = own ?? oldest;
    if (!chosen) return { ...roster, waiting: [...roster.waiting, key] };
    const seat: SeatSlot = { key, replaces: own ? null : chosen.s.freedBy, freedBy: null, freedSeq: null };
    return { ...roster, slots: roster.slots.map((s, i) => (i === chosen.i ? seat : s)) };
  });
}

function isPlaced(rosters: HourRoster[], key: VoterKey, time: string): boolean {
  return rosters.some((r) => r.time === time && (r.waiting.includes(key) || r.slots.some((s) => s.key === key)));
}

/** Applique les changements de vote dans l'ordre reçu (spec §4.6 règles 1 à 3). Pure : n'altère pas les entrées. */
export function applyMoves(
  rosters: HourRoster[],
  moves: Array<{ key: VoterKey; option: string | null }>,
  candidateStartTimes: string[],
): HourRoster[] {
  return moves.reduce((current, { key, option }) => {
    const target = option !== null && candidateStartTimes.includes(option) ? option : null;
    if (target !== null && isPlaced(current, key, target)) return current; // règle 3
    return target === null ? withdraw(current, key) : enter(withdraw(current, key), key, target, candidateStartTimes);
  }, rosters);
}
