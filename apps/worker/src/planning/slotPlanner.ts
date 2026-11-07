import { MAX_PLAYERS_PER_COURT_GROUP, MIN_PLAYERS_PER_COURT_GROUP, SQUASH_COURT_COUNT, SQUASH_SLOT_MINUTES } from "./constants.js";
import type { AvailableSlot } from "./courtAssignment.js";
import { effectiveMinutesPerSlot } from "./effectivePlayTime.js";
import type { PlayerPlaySlotsMap } from "./playerPlaySlots.js";
import { assignNames, type LineToName, type NamePool } from "./slotNames.js";
import { formatTeamrTimeFromMinutes, parseTeamrTime } from "./teamrTime.js";

/**
 * Moteur de plan créneau par créneau (ADR-039). Fonction pure : à chaque créneau de 45 min, les
 * joueurs arrivés (heure votée ≤ créneau) sous leur minimum de temps de jeu effectif décident du
 * nombre de courts (2 joueurs par court visés, 3 en rotation de dépannage) ; les noms TeamR sont
 * attribués sur l'ensemble des lignes à chaque ajout (slotNames.ts), si bien qu'un manque de
 * crédits retombe toujours sur les derniers créneaux.
 */

export interface SlotPlannerInput {
  /** Heure votée de chaque joueur réel, dans l'ordre d'arrivée (heure puis ordre des votes). */
  arrivals: ReadonlyArray<{ playerId: string; voteTime: string }>;
  availableSlots: readonly AvailableSlot[];
  playerPlaySlots: PlayerPlaySlotsMap;
  maxCourtsPerSlot: number;
  maxPlayersPerCourt: number;
  preferMinPlayersPerCourt: boolean;
  courtPriority: readonly number[];
  availabilityWindowHours: number;
  maxDailyReservationsPerPlayer: number;
  priorityBookers: readonly string[];
  /** Prête-noms, dans l'ordre (volontaires du sondage puis prête-noms de la règle). */
  lenderIds: readonly string[];
  jokerBookerId: string | null;
  /** Joueurs qui jouent mais ne peuvent pas porter de nom (non réinscrits, refusés à la réservation). */
  nameBlockedIds: ReadonlySet<string>;
  /** Noms exclus d'office (prête-nom ou joker refusé par TeamR, ADR-039 point 6). */
  excludedBookerIds: ReadonlySet<string>;
}

export interface PlannedCourt {
  court: number;
  slot: AvailableSlot;
  players: string[];
  userId: string;
  partnerId: string;
}

export interface PlannedSlot {
  time: string;
  courts: PlannedCourt[];
  sittingOut: string[];
}

export interface SlotPlan {
  slots: PlannedSlot[];
  effectiveMinutes: Map<string, number>;
  warnings: string[];
}

function minutesOf(time: string): number {
  return parseTeamrTime(time) ?? 0;
}

function slotsByTime(slots: readonly AvailableSlot[]): Map<number, AvailableSlot[]> {
  const byTime = new Map<number, AvailableSlot[]>();
  for (const s of slots) {
    const m = parseTeamrTime(s.beginTime);
    if (m == null) continue;
    const list = byTime.get(m) ?? [];
    if (!list.some((x) => x.court === s.court)) list.push(s);
    byTime.set(m, list);
  }
  return byTime;
}

function wantedCourts(needyCount: number, input: SlotPlannerInput): number {
  if (needyCount <= 0) return 0;
  const perCourt = Math.min(input.maxPlayersPerCourt, MAX_PLAYERS_PER_COURT_GROUP);
  const raw = input.preferMinPlayersPerCourt
    ? Math.floor(needyCount / MIN_PLAYERS_PER_COURT_GROUP)
    : Math.ceil(needyCount / perCourt);
  return Math.max(1, Math.min(raw, input.maxCourtsPerSlot, SQUASH_COURT_COUNT));
}

/** Courts du créneau : ceux où jouaient le plus de joueurs retenus (un groupe garde son court), puis l'ordre de priorité. */
function pickCourts(
  free: readonly AvailableSlot[],
  previousCourtOf: ReadonlyMap<string, number>,
  playing: readonly string[],
  priority: readonly number[],
  count: number,
): AvailableSlot[] {
  const stayers = (court: number) => playing.filter((id) => previousCourtOf.get(id) === court).length;
  const rank = (court: number) => {
    const i = priority.indexOf(court);
    return i < 0 ? priority.length + court : i;
  };
  return [...free].sort((a, b) => stayers(b.court) - stayers(a.court) || rank(a.court) - rank(b.court)).slice(0, count);
}

/** Répartit les joueurs retenus sur les courts (2 chacun, le surplus en 3e), en gardant chacun sur son court précédent si possible. */
function seatPlayers(
  playing: readonly string[],
  courts: readonly AvailableSlot[],
  previousCourtOf: ReadonlyMap<string, number>,
): Map<number, string[]> {
  const sizes = courts.map(() => MIN_PLAYERS_PER_COURT_GROUP);
  for (let extra = playing.length - sizes.length * MIN_PLAYERS_PER_COURT_GROUP, i = 0; extra > 0; extra -= 1, i = (i + 1) % sizes.length) {
    sizes[i]! += 1;
  }
  const seats = new Map<number, string[]>(courts.map((c) => [c.court, []]));
  const capacity = new Map<number, number>(courts.map((c, i) => [c.court, sizes[i]!]));
  const rest: string[] = [];
  for (const id of playing) {
    const prev = previousCourtOf.get(id);
    const list = prev == null ? undefined : seats.get(prev);
    if (list && list.length < capacity.get(prev!)!) list.push(id);
    else rest.push(id);
  }
  for (const id of rest) {
    const court = courts.find((c) => seats.get(c.court)!.length < capacity.get(c.court)!)!;
    seats.get(court.court)!.push(id);
  }
  return seats;
}

export function planSlots(input: SlotPlannerInput): SlotPlan {
  const warnings: string[] = [];
  const effective = new Map<string, number>(input.arrivals.map((a) => [a.playerId, 0]));
  const arrivalMinutes = new Map(input.arrivals.map((a) => [a.playerId, minutesOf(a.voteTime)]));
  const minMinutes = (id: string) => (input.playerPlaySlots.get(id)?.minSlots ?? 2) * SQUASH_SLOT_MINUTES;
  const arrivalOrder = new Map(input.arrivals.map((a, i) => [a.playerId, i]));
  const players = input.arrivals.map((a) => a.playerId);
  const playerSet = new Set(players);
  const lenders = input.lenderIds.filter((id) => !playerSet.has(id) && !input.excludedBookerIds.has(id) && id !== input.jokerBookerId);
  // Un joker qui vote comme joueur est un joueur comme les autres (plafonné), pas un recours.
  const jokerId =
    input.jokerBookerId && !input.excludedBookerIds.has(input.jokerBookerId) && !playerSet.has(input.jokerBookerId)
      ? input.jokerBookerId
      : null;
  const playerCredits = new Map(
    players.map((id) => [id, input.nameBlockedIds.has(id) || input.excludedBookerIds.has(id) ? 0 : input.maxDailyReservationsPerPlayer]),
  );
  const pool = (withJoker: boolean): NamePool => ({
    playerCredits,
    lenders: lenders.map((id) => ({ id, credits: input.maxDailyReservationsPerPlayer })),
    jokerId: withJoker ? jokerId : null,
    priorityBookers: input.priorityBookers,
  });

  if (players.length === 0) return { slots: [], effectiveMinutes: effective, warnings };

  const byTime = slotsByTime(input.availableSlots);
  const firstArrival = Math.min(...arrivalMinutes.values());
  const lastArrival = Math.max(...arrivalMinutes.values());
  // Fenêtre acceptée (ADR-014) : un joueur n'est servi que jusqu'à son heure votée + availabilityWindowHours.
  const windowMinutes = input.availabilityWindowHours * 60;
  const horizon = lastArrival + windowMinutes;
  const planned: PlannedSlot[] = [];
  const lines: LineToName[] = [];
  let usesJoker = false;
  let namesWarned = false;
  let previousCourtOf = new Map<string, number>();

  for (let t = firstArrival; t <= horizon; t += SQUASH_SLOT_MINUTES) {
    const time = formatTeamrTimeFromMinutes(t);
    const present = players.filter((id) => arrivalMinutes.get(id)! <= t);
    const needy = present.filter((id) => effective.get(id)! < minMinutes(id) && t <= arrivalMinutes.get(id)! + windowMinutes);
    if (needy.length === 0) {
      if (t >= lastArrival) break;
      continue;
    }

    const free = byTime.get(t) ?? [];
    const maxK = Math.min(wantedCourts(needy.length, input), free.length, Math.floor(present.length / MIN_PLAYERS_PER_COURT_GROUP));
    let accepted: { courts: AvailableSlot[]; seats: Map<number, string[]>; names: ReturnType<typeof assignNames> } | null = null;

    for (let k = maxK; k >= 1 && !accepted; k -= 1) {
      const playing = choosePlaying(needy, present, k, input, effective, arrivalOrder);
      const courts = pickCourts(free, previousCourtOf, playing, input.courtPriority, k);
      const seats = seatPlayers(playing, courts, previousCourtOf);
      const candidate = [
        ...lines,
        ...courts.map((c) => ({ slotTime: time, onCourt: seats.get(c.court)!, present })),
      ];
      const jokerModes: boolean[] = usesJoker ? [true] : [false, true];
      for (const withJoker of jokerModes) {
        if (withJoker && !jokerId) continue;
        const names = assignNames(candidate, pool(withJoker));
        if (names) {
          accepted = { courts, seats, names };
          usesJoker = withJoker;
          break;
        }
      }
    }

    if (!accepted) {
      if (maxK >= 1 && !namesWarned) {
        namesWarned = true;
        const fallback = jokerId ? "joker compris" : "aucun prête-nom disponible et aucun joker configuré sur la règle";
        warnings.push(`${time} : pas assez de noms TeamR pour réserver un court (plafond de résas/jour atteint ou joueurs non réinscrits, ${fallback}).`);
      }
      // Faute de noms, rien ne s'améliorera plus tard (les crédits ne reviennent pas) ; faute de
      // court libre ou de partenaire, un créneau suivant peut encore servir.
      if (maxK >= 1 && t >= lastArrival) break;
      continue;
    }

    for (const c of accepted.courts) lines.push({ slotTime: time, onCourt: accepted.seats.get(c.court)!, present });
    const playingNow = new Set<string>();
    const courts: PlannedCourt[] = accepted.courts.map((slot) => {
      const seated = accepted!.seats.get(slot.court)!;
      for (const id of seated) {
        playingNow.add(id);
        effective.set(id, effective.get(id)! + effectiveMinutesPerSlot(seated.length));
      }
      return { court: slot.court, slot, players: seated, userId: "", partnerId: "" };
    });
    // Seuls les joueurs encore sous leur minimum « restent sur le banc » : les autres ont fini.
    planned.push({ time, courts, sittingOut: needy.filter((id) => !playingNow.has(id)) });
    previousCourtOf = new Map(courts.flatMap((c) => c.players.map((id) => [id, c.court] as const)));

    // Les noms de toutes les lignes sont recalculés à chaque ajout : on recopie la dernière solution.
    let i = 0;
    for (const s of planned) for (const c of s.courts) Object.assign(c, accepted.names![i++]!);
  }

  for (const id of players) {
    const got = effective.get(id)!;
    if (got < minMinutes(id)) {
      warnings.push(`${id} : ${Math.round(got)} min de jeu effectif sur ${minMinutes(id)} visées (min effectif non atteint, faute de courts ou de noms pour réserver).`);
    }
  }
  return { slots: planned, effectiveMinutes: effective, warnings };
}

/** Joueurs retenus sur k courts : les plus en retard sur leur minimum d'abord, complétés au besoin par des joueurs déjà servis. */
function choosePlaying(
  needy: readonly string[],
  present: readonly string[],
  k: number,
  input: SlotPlannerInput,
  effective: ReadonlyMap<string, number>,
  arrivalOrder: ReadonlyMap<string, number>,
): string[] {
  const byNeed = (a: string, b: string) => effective.get(a)! - effective.get(b)! || arrivalOrder.get(a)! - arrivalOrder.get(b)!;
  const capacity = k * Math.min(input.maxPlayersPerCourt, MAX_PLAYERS_PER_COURT_GROUP);
  const playing = [...needy].sort(byNeed).slice(0, capacity);
  const fillers = present.filter((id) => !needy.includes(id)).sort(byNeed);
  while (playing.length < k * MIN_PLAYERS_PER_COURT_GROUP && fillers.length > 0) playing.push(fillers.shift()!);
  return playing;
}
