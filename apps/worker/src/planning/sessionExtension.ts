import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import type { AvailableSlot } from "./courtAssignment.js";
import {
  effectiveMinutesPerSlot,
  slotsNeededFromJoin,
  targetEffectiveMinutes,
} from "./effectivePlayTime.js";
import {
  DEFAULT_PLAY_SLOTS,
  resolvePlayerPlaySlots,
  type PlayerPlaySlotsMap,
  type PlaySlotsDefaults,
} from "./playerPlaySlots.js";
import { formatTeamrTimeFromMinutes, parseTeamrTime, slotStartDateIsoHeuristicParis } from "./teamrTime.js";

export interface OngoingSession {
  court: number;
  /** Heure candidate qui a ouvert la session (pour la fenêtre availabilityWindowHours). */
  anchorStartTime: string;
  /** Joueurs réels présents sur le court (pas les prête-noms TeamR). */
  players: string[];
  /** Heure d'arrivée sur le court par joueur (vote ou début de session). */
  playerJoinTimes: Map<string, string>;
  pairUserId: string;
  pairPartnerId: string;
  rotatingPlayerIds: string[];
  proposedBookings: GroupBookingPlan["proposedBookings"];
  groupIndex: number;
}

export interface ExtendSessionOptions {
  session: OngoingSession;
  lateJoinerIds: string[];
  joinTime: string;
  targetDate: string;
  groupId: string;
  /** Fallback couches initiales / calcul maxExtra (souvent rule.maxReservationsPerPlayer). */
  slotsPerPlayer: number;
  maxPlayersPerCourt: number;
  /** Plafond TeamR groupe (rule.maxDailyReservationsPerPlayer) — pas le max effectif joueur. */
  maxDailyReservationsPerPlayer: number;
  availabilityWindowHours: number;
  availableSlots: AvailableSlot[];
  usedSessionIds: Set<string>;
  /** Prête-noms encore disponibles (volontaires + substituteBookers), mutés à la consommation. */
  substituteQueue: string[];
  existingDailyCounts: Readonly<Record<string, number>>;
  apiUserId: string | null;
  /** Quotas effectifs min/max par joueur (option B). */
  playerPlaySlots: PlayerPlaySlotsMap;
  playSlotsDefaults?: PlaySlotsDefaults;
  warnings: string[];
}

function lastSlotEndTime(bookings: GroupBookingPlan["proposedBookings"], court: number): string | null {
  let best: string | null = null;
  let bestMin = -1;
  for (const b of bookings) {
    if (b.court !== court) continue;
    const end = parseTeamrTime(b.slotEndTime);
    if (end != null && end > bestMin) {
      bestMin = end;
      best = b.slotEndTime;
    }
  }
  return best;
}

function sessionCoversJoinTime(session: OngoingSession, timeKey: string): boolean {
  const joinMin = parseTeamrTime(timeKey);
  if (joinMin == null) return false;
  const anchor = parseTeamrTime(session.anchorStartTime);
  if (anchor == null) return false;
  if (joinMin < anchor) return false;
  const lastEnd = lastSlotEndTime(session.proposedBookings, session.court);
  if (!lastEnd) return true;
  const endMin = parseTeamrTime(lastEnd);
  return endMin != null && joinMin <= endMin;
}

function withinAvailabilityWindow(anchorStartTime: string, timeKey: string, windowHours: number): boolean {
  const anchor = parseTeamrTime(anchorStartTime);
  const t = parseTeamrTime(timeKey);
  if (anchor == null || t == null) return true;
  return t <= anchor + windowHours * 60;
}

/** Extrait une session par court à partir d'un plan calculé pour une heure candidate. */
export function buildOngoingSessionsFromPlan(
  plan: GroupBookingPlan,
  anchorStartTime: string,
  groupIndex: number,
  confirmedPlayerIds: string[],
): OngoingSession[] {
  if (plan.proposedBookings.length === 0) return [];

  const byCourt = new Map<number, GroupBookingPlan["proposedBookings"]>();
  for (const b of plan.proposedBookings) {
    const arr = byCourt.get(b.court) ?? [];
    arr.push(b);
    byCourt.set(b.court, arr);
  }

  const confirmedSet = new Set(confirmedPlayerIds);
  const sessions: OngoingSession[] = [];
  for (const [court, bookings] of byCourt) {
    const sorted = [...bookings].sort(
      (a, b) => (parseTeamrTime(a.slotTime) ?? 0) - (parseTeamrTime(b.slotTime) ?? 0),
    );
    const first = sorted[0]!;
    // Seuls les joueurs réellement réservés sur CE court (pas tout le groupe, qui peut
    // couvrir plusieurs courts en //) — sinon un late joiner apparaît déjà "présent" sur
    // chaque court à la fois et extendSessionForLateJoiners ne l'ajoute nulle part
    // (régression 2026-08-23 : 7 joueurs / 3 courts, le 7e disparaissait du plan).
    const bookedIds = sorted.flatMap((b) => [b.userId, b.partnerId]).filter((id): id is string => id != null);
    const players = [...new Set(bookedIds.filter((id) => confirmedSet.has(id)))];
    const joinTimes = new Map<string, string>();
    for (const id of players) joinTimes.set(id, anchorStartTime);
    const rotating = plan.meta.rotatingPlayerIds ?? [];
    sessions.push({
      court,
      anchorStartTime,
      players,
      playerJoinTimes: joinTimes,
      pairUserId: first.userId,
      pairPartnerId: first.partnerId ?? "",
      rotatingPlayerIds: [...rotating],
      proposedBookings: sorted,
      groupIndex,
    });
  }
  return sessions;
}

function teamrCountForPlayer(
  bookings: GroupBookingPlan["proposedBookings"],
  playerId: string,
): number {
  let n = 0;
  for (const b of bookings) {
    if (b.userId === playerId || b.partnerId === playerId) n += 1;
  }
  return n;
}

function underTeamrLimit(
  playerId: string,
  bookings: GroupBookingPlan["proposedBookings"],
  existingDailyCounts: Readonly<Record<string, number>>,
  maxDaily: number,
  apiUserId: string | null,
): boolean {
  if (apiUserId && playerId === apiUserId) return true;
  const existing = existingDailyCounts[playerId] ?? 0;
  return existing + teamrCountForPlayer(bookings, playerId) < maxDaily;
}

function playersPresentAtSlot(
  slotTime: string,
  players: string[],
  playerJoinTimes: Map<string, string>,
): string[] {
  const slotMin = parseTeamrTime(slotTime) ?? 0;
  return players.filter((id) => (parseTeamrTime(playerJoinTimes.get(id) ?? "") ?? 0) <= slotMin);
}

function cumulativeEffectiveMinutes(
  playerId: string,
  bookings: GroupBookingPlan["proposedBookings"],
  players: string[],
  playerJoinTimes: Map<string, string>,
): number {
  const joinMin = parseTeamrTime(playerJoinTimes.get(playerId) ?? "") ?? 0;
  let total = 0;
  for (const b of bookings) {
    const slotMin = parseTeamrTime(b.slotTime);
    if (slotMin == null || slotMin < joinMin) continue;
    const present = playersPresentAtSlot(b.slotTime, players, playerJoinTimes);
    if (!present.includes(playerId)) continue;
    total += effectiveMinutesPerSlot(present.length);
  }
  return total;
}

function allPlayersMeetEffectiveMin(
  players: string[],
  bookings: GroupBookingPlan["proposedBookings"],
  playerJoinTimes: Map<string, string>,
  playerPlaySlots: PlayerPlaySlotsMap,
  defaults: PlaySlotsDefaults,
): boolean {
  for (const id of players) {
    const { minSlots } = resolvePlayerPlaySlots(id, defaults, playerPlaySlots);
    const effective = cumulativeEffectiveMinutes(id, bookings, players, playerJoinTimes);
    if (effective < targetEffectiveMinutes(minSlots)) return false;
  }
  return true;
}

function playersShortOfMin(
  players: string[],
  bookings: GroupBookingPlan["proposedBookings"],
  playerJoinTimes: Map<string, string>,
  playerPlaySlots: PlayerPlaySlotsMap,
  defaults: PlaySlotsDefaults,
): string[] {
  const short: string[] = [];
  for (const id of players) {
    const { minSlots } = resolvePlayerPlaySlots(id, defaults, playerPlaySlots);
    const effective = cumulativeEffectiveMinutes(id, bookings, players, playerJoinTimes);
    if (effective < targetEffectiveMinutes(minSlots)) short.push(id);
  }
  return short;
}

function findSlotOnCourt(
  availableSlots: AvailableSlot[],
  usedSessionIds: ReadonlySet<string>,
  court: number,
  beginTime: string,
): AvailableSlot | null {
  for (const s of availableSlots) {
    if (s.court !== court || s.beginTime !== beginTime) continue;
    if (usedSessionIds.has(s.sessionId)) continue;
    return s;
  }
  return null;
}

function nextSlotBeginTime(afterEndTime: string): string | null {
  const endMin = parseTeamrTime(afterEndTime);
  if (endMin == null) return null;
  return formatTeamrTimeFromMinutes(endMin);
}

/**
 * Choisit la paire TeamR pour un créneau de prolongation sans dépasser le plafond
 * de résas/jour : d'abord la paire d'origine si encore sous plafond, sinon un
 * late joiner + prête-nom (le prête-nom tient la ligne TeamR pendant que les
 * joueurs d'origine restent présents en rotation physique).
 */
function pickTeamrNamesForExtension(
  session: OngoingSession,
  lateJoinerIds: string[],
  bookings: GroupBookingPlan["proposedBookings"],
  substituteQueue: string[],
  existingDailyCounts: Readonly<Record<string, number>>,
  maxDaily: number,
  apiUserId: string | null,
  warnings: string[],
): { userId: string; partnerId: string } | null {
  const ok = (id: string) => underTeamrLimit(id, bookings, existingDailyCounts, maxDaily, apiUserId);

  if (session.pairUserId && session.pairPartnerId && ok(session.pairUserId) && ok(session.pairPartnerId)) {
    return { userId: session.pairUserId, partnerId: session.pairPartnerId };
  }

  const takeSub = (): string | null => {
    for (let i = 0; i < substituteQueue.length; i += 1) {
      const sub = substituteQueue[i]!;
      if (!ok(sub)) continue;
      // Retire seulement s'il atteindra le plafond après CE créneau (réutilisable
      // sinon sur les créneaux suivants de la même prolongation — ex. Martin+Mustapha ×2).
      const afterThis = (existingDailyCounts[sub] ?? 0) + teamrCountForPlayer(bookings, sub) + 1;
      if (afterThis >= maxDaily && !(apiUserId && sub === apiUserId)) {
        substituteQueue.splice(i, 1);
      }
      return sub;
    }
    return null;
  };

  const candidates = [
    ...lateJoinerIds.filter((id) => session.players.includes(id)),
    ...session.players.filter((id) => !lateJoinerIds.includes(id)),
  ];
  for (const real of candidates) {
    if (!ok(real)) continue;
    const sub = takeSub();
    if (!sub) {
      warnings.push(
        `Court ${session.court} : ${real} sous plafond mais aucun prête-nom disponible pour prolonger la rotation.`,
      );
      return null;
    }
    const notice = `Court ${session.court} : prolongation TeamR avec ${real} + prête-nom ${sub} (paire d'origine au plafond ${maxDaily} résas/jour) — rotation physique maintenue pour ${session.players.join(", ")}.`;
    if (!warnings.includes(notice)) warnings.push(notice);
    return { userId: real, partnerId: sub };
  }

  warnings.push(
    `Court ${session.court} : impossible de prolonger — tous les joueurs présents sont au plafond ${maxDaily} résas/jour et aucun prête-nom ne peut ouvrir un créneau.`,
  );
  return null;
}

/**
 * Prolonge une session pour accueillir des joueurs tardifs et atteindre le quota
 * de temps de jeu effectif. Ne dépasse jamais maxDailyReservationsPerPlayer sur
 * une ligne TeamR : au-delà, bascule sur late joiner + prête-nom.
 */
export function extendSessionForLateJoiners(opts: ExtendSessionOptions): GroupBookingPlan["proposedBookings"] {
  const {
    session,
    lateJoinerIds,
    joinTime,
    targetDate,
    groupId,
    slotsPerPlayer,
    maxPlayersPerCourt,
    maxDailyReservationsPerPlayer,
    availabilityWindowHours,
    availableSlots,
    usedSessionIds,
    substituteQueue,
    existingDailyCounts,
    apiUserId,
    playerPlaySlots,
    playSlotsDefaults = DEFAULT_PLAY_SLOTS,
    warnings,
  } = opts;

  const added: GroupBookingPlan["proposedBookings"] = [];
  const players = [...session.players];
  for (const id of lateJoinerIds) {
    if (players.includes(id)) continue;
    if (players.length >= maxPlayersPerCourt) {
      warnings.push(`Court ${session.court} : impossible d'ajouter ${id} (plafond ${maxPlayersPerCourt} joueurs/court).`);
      continue;
    }
    players.push(id);
    session.playerJoinTimes.set(id, joinTime);
  }
  session.players = players;
  session.rotatingPlayerIds = players.filter((id) => id !== session.pairUserId && id !== session.pairPartnerId);

  const n = players.length;
  const maxMinSlots = Math.max(
    slotsPerPlayer,
    ...players.map((id) => resolvePlayerPlaySlots(id, playSlotsDefaults, playerPlaySlots).minSlots),
  );
  if (n > 2) {
    warnings.push(
      `Rotation à ${n} sur court ${session.court} : ${effectiveMinutesPerSlot(n)} min effectives/créneau — prolongation jusqu'au min effectif de chaque joueur (plafond TeamR règle : ${maxDailyReservationsPerPlayer} résas/jour).`,
    );
  }

  const allBookings = () => [...session.proposedBookings, ...added];
  let lastEnd = lastSlotEndTime(allBookings(), session.court) ?? joinTime;
  const maxExtra = slotsNeededFromJoin(Math.max(n, 2), maxMinSlots) + 4;

  for (let attempt = 0; attempt < maxExtra; attempt += 1) {
    if (allPlayersMeetEffectiveMin(players, allBookings(), session.playerJoinTimes, playerPlaySlots, playSlotsDefaults)) {
      break;
    }

    const nextBegin = nextSlotBeginTime(lastEnd);
    if (!nextBegin) break;
    if (!withinAvailabilityWindow(session.anchorStartTime, nextBegin, availabilityWindowHours)) {
      warnings.push(
        `Court ${session.court} : prolongation arrêtée à ${nextBegin} (hors fenêtre ${availabilityWindowHours}h depuis ${session.anchorStartTime}).`,
      );
      break;
    }

    const names = pickTeamrNamesForExtension(
      session,
      lateJoinerIds,
      allBookings(),
      substituteQueue,
      existingDailyCounts,
      maxDailyReservationsPerPlayer,
      apiUserId,
      warnings,
    );
    if (!names) {
      const short = playersShortOfMin(players, allBookings(), session.playerJoinTimes, playerPlaySlots, playSlotsDefaults);
      if (short.length > 0) {
        warnings.push(
          `Court ${session.court} : min effectif non atteint pour ${short.join(", ")} (plafond TeamR ou prête-nom manquant).`,
        );
      }
      break;
    }

    const slot = findSlotOnCourt(availableSlots, usedSessionIds, session.court, nextBegin);
    if (!slot) {
      warnings.push(`Court ${session.court} : pas de créneau libre à ${nextBegin} pour prolonger la rotation.`);
      const short = playersShortOfMin(players, allBookings(), session.playerJoinTimes, playerPlaySlots, playSlotsDefaults);
      if (short.length > 0) {
        warnings.push(`Court ${session.court} : min effectif non atteint pour ${short.join(", ")}.`);
      }
      break;
    }

    const startDate = slotStartDateIsoHeuristicParis(targetDate, slot.beginTime);
    if (!startDate) break;

    const booking = {
      sessionId: slot.sessionId,
      userId: names.userId,
      partnerId: names.partnerId,
      startDate,
      court: session.court,
      slotTime: slot.beginTime,
      slotEndTime: slot.endTime,
      groupId,
    };
    added.push(booking);
    usedSessionIds.add(slot.sessionId);
    lastEnd = slot.endTime;
  }

  const stillShort = playersShortOfMin(players, allBookings(), session.playerJoinTimes, playerPlaySlots, playSlotsDefaults);
  if (stillShort.length > 0) {
    const notice = `Court ${session.court} : min effectif non atteint pour ${stillShort.join(", ")}.`;
    if (!warnings.includes(notice)) warnings.push(notice);
  }

  session.proposedBookings.push(...added);
  return added;
}

/** Cherche une session fusionnable pour des joueurs orphelins à une heure candidate tardive. */
export function findMergeableSession(
  sessions: OngoingSession[],
  orphanJoinTime: string,
  orphanCount: number,
  maxPlayersPerCourt: number,
  availabilityWindowHours: number,
): OngoingSession | null {
  for (const session of sessions) {
    if (!withinAvailabilityWindow(session.anchorStartTime, orphanJoinTime, availabilityWindowHours)) continue;
    if (!sessionCoversJoinTime(session, orphanJoinTime)) continue;
    if (session.players.length + orphanCount > maxPlayersPerCourt) continue;
    return session;
  }
  return null;
}

/** Fusionne des réservations dans le plan d'un groupe et met à jour meta.rotatingPlayerIds. */
export function appendBookingsToGroupPlan(
  plan: GroupBookingPlan,
  extra: GroupBookingPlan["proposedBookings"],
  rotatingPlayerIds: string[],
): void {
  plan.proposedBookings.push(...extra);
  plan.meta.rotatingPlayerIds = rotatingPlayerIds;
  plan.meta.roundsPlanned += extra.length;
}
