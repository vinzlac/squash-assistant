import type { BookingPlanGroup } from "../graph/state.js";
import type { BookingRule } from "../config.js";
import type { AvailableSlot } from "./courtAssignment.js";
import {
  buildPlayerPlaySlotsMap,
  DEFAULT_PLAY_SLOTS,
  type PlayerPlaySlots,
  type PlaySlotsDefaults,
} from "./playerPlaySlots.js";
import { planSlots } from "./slotPlanner.js";
import { toBookingPlanGroups } from "./slotPlanGroups.js";

export interface PlanJobPlaySlotsOptions {
  defaults?: PlaySlotsDefaults;
  overrides?: ReadonlyMap<string, PlayerPlaySlots> | Readonly<Record<string, PlayerPlaySlots>>;
  /** Noms refusés par TeamR à la réservation (prête-nom ou joker) : exclus au recalcul (ADR-039 point 6). */
  excludedBookerIds?: ReadonlySet<string>;
}

/**
 * Un joueur seul (aucun partenaire) à une heure candidate est déplacé vers l'heure candidate
 * suivante immédiate — on part du principe qu'un joueur disponible tôt l'est aussi plus tard,
 * jamais l'inverse (règle 2026-08-12, voir regles-fonctionnelles.md). Un seul saut : si l'heure
 * suivante devient à son tour seule après ce déplacement, elle n'est pas re-cascadée plus loin.
 * Fonction pure — appelée avant applyUnexpectedPlayersMargin (la cascade porte sur les votes
 * réels, pas sur les joueurs de marge ajoutés ensuite).
 */
export function cascadeSoloVotersForward(
  candidateStartTimes: string[],
  confirmedPlayerIdsByTime: Record<string, string[]>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const time of candidateStartTimes) {
    result[time] = [...(confirmedPlayerIdsByTime[time] ?? [])];
  }

  for (let i = 0; i < candidateStartTimes.length - 1; i += 1) {
    const time = candidateStartTimes[i]!;
    const nextTime = candidateStartTimes[i + 1]!;
    const original = confirmedPlayerIdsByTime[time] ?? [];
    if (original.length === 1 && result[time]!.length === 1) {
      const [soloId] = original;
      result[time] = result[time]!.filter((id) => id !== soloId);
      result[nextTime] = [...result[nextTime]!, soloId!];
    }
  }

  return result;
}

/**
 * Ajoute `unexpectedPlayersMargin` joueurs "imprévus" à chaque heure ayant déjà des confirmés —
 * traités exactement comme des confirmés réels (mêmes créneaux, même pairing), pas comme des
 * prête-noms de repli. Sourcés du même pool que la substitution quota (volontaires du sondage
 * "Prête mon nom", ADR-017, prioritaires sur substituteBookers de la règle, ADR-016) — jamais
 * deux fois le même jour, jamais un id déjà confirmé. Une heure sans aucun confirmé ne reçoit pas
 * de marge (rien à provisionner en plus de zéro joueur).
 */
function applyUnexpectedPlayersMargin(
  bookingRule: BookingRule,
  confirmedPlayerIdsByTime: Record<string, string[]>,
  volunteerSubstituteIds: string[],
): Record<string, string[]> {
  if (bookingRule.unexpectedPlayersMargin <= 0) return confirmedPlayerIdsByTime;

  const alreadyConfirmed = new Set(Object.values(confirmedPlayerIdsByTime).flat());
  const eligible = (id: string) => !alreadyConfirmed.has(id);
  const volunteers = volunteerSubstituteIds.filter(eligible);
  const volunteerSet = new Set(volunteers);
  const defaults = bookingRule.substituteBookers.filter((id) => eligible(id) && !volunteerSet.has(id));
  const pool = [...volunteers, ...defaults];
  const usedForMargin = new Set<string>();
  const result: Record<string, string[]> = {};

  for (const [time, ids] of Object.entries(confirmedPlayerIdsByTime)) {
    if (ids.length === 0) {
      result[time] = ids;
      continue;
    }
    const extra: string[] = [];
    for (const candidate of pool) {
      if (extra.length >= bookingRule.unexpectedPlayersMargin) break;
      if (usedForMargin.has(candidate)) continue;
      extra.push(candidate);
      usedForMargin.add(candidate);
    }
    result[time] = [...ids, ...extra];
  }

  return result;
}

/**
 * Plan de réservation d'un job, créneau par créneau sur toutes les heures candidates à la fois
 * (ADR-039) : tous les inscrits jouent avant que quiconque dépasse son minimum, 2 joueurs par
 * court visés, prête-noms puis joker pour les noms qui manquent. Fonction pure, aucun I/O —
 * partagée entre le nœud réel (bookSlots.ts, disponibilité via list_availability), le simulateur
 * (simulateScenario.ts) et le recalcul après refus d'un prête-nom à la réservation.
 * `apiUserId` n'a plus d'effet sur le plan (plafonné comme tout joueur depuis le 2026-08-27).
 */
export function planJobBookings(
  bookingRule: BookingRule,
  targetDate: string,
  confirmedPlayerIdsByTime: Record<string, string[]>,
  volunteerSubstituteIds: string[],
  availableSlots: AvailableSlot[],
  _apiUserId: string | null,
  playSlotsOptions?: PlanJobPlaySlotsOptions,
  /** Joueurs non réinscrits (resa-squash ADR-011) : ils jouent mais ne portent pas de nom TeamR. */
  unregisteredPlayerIds: ReadonlySet<string> = new Set(),
): BookingPlanGroup[] {
  const cascaded = cascadeSoloVotersForward(bookingRule.candidateStartTimes, confirmedPlayerIdsByTime);
  const withMargin = applyUnexpectedPlayersMargin(bookingRule, cascaded, volunteerSubstituteIds);

  const voteTimeOf = new Map<string, string>();
  const arrivals: Array<{ playerId: string; voteTime: string }> = [];
  for (const voteTime of bookingRule.candidateStartTimes) {
    for (const playerId of withMargin[voteTime] ?? []) {
      if (voteTimeOf.has(playerId)) continue;
      voteTimeOf.set(playerId, voteTime);
      arrivals.push({ playerId, voteTime });
    }
  }
  const lenderIds = [...new Set([...volunteerSubstituteIds, ...bookingRule.substituteBookers])].filter(
    (id) => !voteTimeOf.has(id),
  );
  const playSlotsDefaults = playSlotsOptions?.defaults ?? DEFAULT_PLAY_SLOTS;
  const playerPlaySlots = buildPlayerPlaySlotsMap(
    arrivals.map((a) => a.playerId),
    playSlotsDefaults,
    playSlotsOptions?.overrides ?? new Map(),
  );

  const plan = planSlots({
    arrivals,
    availableSlots,
    playerPlaySlots,
    maxCourtsPerSlot: bookingRule.maxCourtsPerSlot,
    maxPlayersPerCourt: bookingRule.maxPlayersPerCourt,
    preferMinPlayersPerCourt: bookingRule.preferMinPlayersPerCourt,
    courtPriority: bookingRule.courtPriority,
    availabilityWindowHours: bookingRule.availabilityWindowHours,
    maxDailyReservationsPerPlayer: bookingRule.maxDailyReservationsPerPlayer,
    priorityBookers: bookingRule.priorityBookers,
    lenderIds,
    jokerBookerId: bookingRule.jokerBookerId,
    nameBlockedIds: unregisteredPlayerIds,
    excludedBookerIds: playSlotsOptions?.excludedBookerIds ?? new Set(),
  });

  return toBookingPlanGroups({
    rule: bookingRule,
    targetDate,
    confirmedPlayerIdsByTime: withMargin,
    voteTimeOf,
    plan,
    lenderIds: new Set(lenderIds),
    nameBlockedIds: unregisteredPlayerIds,
  });
}
