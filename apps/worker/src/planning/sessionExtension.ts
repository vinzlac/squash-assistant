import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import type { AvailableSlot } from "./courtAssignment.js";
import {
  effectiveMinutesPerSlot,
  slotsNeededFromJoin,
  targetEffectiveMinutes,
} from "./effectivePlayTime.js";
import { formatTeamrTimeFromMinutes, parseTeamrTime, slotStartDateIsoHeuristicParis } from "./teamrTime.js";

export interface OngoingSession {
  court: number;
  /** Heure candidate qui a ouvert la session (pour la fenêtre availabilityWindowHours). */
  anchorStartTime: string;
  /** Tous les joueurs présents sur le court (paire + rotators). */
  players: string[];
  /** Heure d'arrivée sur le court par joueur (vote ou début de session). */
  playerJoinTimes: Map<string, string>;
  pairUserId: string;
  pairPartnerId: string;
  rotatingPlayerIds: string[];
  proposedBookings: GroupBookingPlan["proposedBookings"];
  groupIndex: number;
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

  const sessions: OngoingSession[] = [];
  for (const [court, bookings] of byCourt) {
    const sorted = [...bookings].sort(
      (a, b) => (parseTeamrTime(a.slotTime) ?? 0) - (parseTeamrTime(b.slotTime) ?? 0),
    );
    const first = sorted[0]!;
    const players = [...new Set(confirmedPlayerIds)];
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

function playersPresentAtSlot(
  slotTime: string,
  players: string[],
  playerJoinTimes: Map<string, string>,
): string[] {
  const slotMin = parseTeamrTime(slotTime) ?? 0;
  return players.filter((id) => (parseTeamrTime(playerJoinTimes.get(id) ?? "") ?? 0) <= slotMin);
}

function allPlayersMeetQuota(
  players: string[],
  bookings: GroupBookingPlan["proposedBookings"],
  playerJoinTimes: Map<string, string>,
  slotsPerPlayer: number,
): boolean {
  const target = targetEffectiveMinutes(slotsPerPlayer);
  for (const id of players) {
    if (cumulativeEffectiveMinutes(id, bookings, players, playerJoinTimes) < target) return false;
  }
  return true;
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
 * Prolonge une session existante pour accueillir des joueurs tardifs (fusion cross-heures)
 * et satisfaire le quota de temps de jeu effectif en rotation.
 */
export function extendSessionForLateJoiners(
  session: OngoingSession,
  lateJoinerIds: string[],
  joinTime: string,
  targetDate: string,
  groupId: string,
  slotsPerPlayer: number,
  maxPlayersPerCourt: number,
  availabilityWindowHours: number,
  availableSlots: AvailableSlot[],
  usedSessionIds: Set<string>,
  warnings: string[],
): GroupBookingPlan["proposedBookings"] {
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
  if (n > 2) {
    warnings.push(
      `Rotation à ${n} sur court ${session.court} : ${effectiveMinutesPerSlot(n)} min effectives/créneau — prolongation pour quota ${targetEffectiveMinutes(slotsPerPlayer)} min/joueur.`,
    );
  }

  const allBookings = () => [...session.proposedBookings, ...added];
  let lastEnd = lastSlotEndTime(allBookings(), session.court) ?? joinTime;
  const maxExtra = slotsNeededFromJoin(n, slotsPerPlayer) + 4;

  for (let attempt = 0; attempt < maxExtra; attempt += 1) {
    if (allPlayersMeetQuota(players, allBookings(), session.playerJoinTimes, slotsPerPlayer)) break;

    const nextBegin = nextSlotBeginTime(lastEnd);
    if (!nextBegin) break;
    if (!withinAvailabilityWindow(session.anchorStartTime, nextBegin, availabilityWindowHours)) {
      warnings.push(
        `Court ${session.court} : prolongation arrêtée à ${nextBegin} (hors fenêtre ${availabilityWindowHours}h depuis ${session.anchorStartTime}).`,
      );
      break;
    }

    const slot = findSlotOnCourt(availableSlots, usedSessionIds, session.court, nextBegin);
    if (!slot) {
      warnings.push(`Court ${session.court} : pas de créneau libre à ${nextBegin} pour prolonger la rotation.`);
      break;
    }

    const startDate = slotStartDateIsoHeuristicParis(targetDate, slot.beginTime);
    if (!startDate) break;

    const booking = {
      sessionId: slot.sessionId,
      userId: session.pairUserId,
      partnerId: session.pairPartnerId,
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
