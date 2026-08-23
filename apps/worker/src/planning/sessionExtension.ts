// apps/worker/src/planning/sessionExtension.ts
import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import type { AvailableSlot } from "./courtAssignment.js";
import { computeRoundsNeededForMembers, orderMembersByDemand, teamrNamesForRound } from "./groups.js";
import type { PlayerPlaySlotsMap, PlaySlotsDefaults } from "./playerPlaySlots.js";
import { formatTeamrTimeFromMinutes, parseTeamrTime, slotStartDateIsoHeuristicParis } from "./teamrTime.js";

export interface OngoingSession {
  court: number;
  /** Heure candidate qui a ouvert la session (pour la fenêtre availabilityWindowHours). */
  anchorStartTime: string;
  /** Joueurs réels confirmés sur ce court (pas les prête-noms TeamR) — 2 ou 3. */
  members: string[];
  /** Nombre de rounds déjà réservés sur ce court. */
  roundsBooked: number;
  /** Cible actuelle (recalculée si des late joiners rejoignent via extendSessionForLateJoiners). */
  roundsNeeded: number;
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
  playSlotsDefaults: PlaySlotsDefaults,
  playerPlaySlots: PlayerPlaySlotsMap,
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
    // Seuls les joueurs réellement réservés sur CE court (pas tout le groupe, qui peut couvrir
    // plusieurs courts en //) — sinon un late joiner apparaît déjà "présent" sur chaque court à
    // la fois (régression 2026-08-23 : 7 joueurs / 3 courts, le 7e disparaissait du plan).
    const bookedIds = sorted.flatMap((b) => [b.userId, b.partnerId]).filter((id): id is string => id != null);
    const members = [...new Set(bookedIds.filter((id) => confirmedSet.has(id)))];
    sessions.push({
      court,
      anchorStartTime,
      members,
      roundsBooked: sorted.length,
      roundsNeeded: computeRoundsNeededForMembers(members, playSlotsDefaults, playerPlaySlots),
      proposedBookings: sorted,
      groupIndex,
    });
  }
  return sessions;
}

function teamrCountForPlayer(bookings: GroupBookingPlan["proposedBookings"], playerId: string): number {
  let n = 0;
  for (const b of bookings) {
    if (b.userId === playerId || b.partnerId === playerId) n += 1;
  }
  return n;
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

export interface ExtendSessionOptions {
  session: OngoingSession;
  lateJoinerIds: string[];
  joinTime: string;
  targetDate: string;
  groupId: string;
  maxPlayersPerCourt: number;
  /** Plafond TeamR groupe (rule.maxDailyReservationsPerPlayer) — pas le quota effectif joueur. */
  maxDailyReservationsPerPlayer: number;
  availabilityWindowHours: number;
  availableSlots: AvailableSlot[];
  usedSessionIds: Set<string>;
  /** Prête-noms encore disponibles (volontaires + substituteBookers), mutés à la consommation. */
  substituteQueue: string[];
  existingDailyCounts: Readonly<Record<string, number>>;
  apiUserId: string | null;
  playSlotsDefaults: PlaySlotsDefaults;
  playerPlaySlots: PlayerPlaySlotsMap;
  warnings: string[];
}

/**
 * Ajoute des late joiners à une session en cours et prolonge jusqu'à ce que le groupe élargi
 * atteigne son nouveau `roundsNeeded` (recalculé, `groups.ts`). Ne dépasse jamais
 * maxDailyReservationsPerPlayer sur une ligne TeamR : au-delà, bascule sur prête-nom. Nommage par
 * round via le cycle round-robin fixe (`teamrNamesForRound`) — pas de suivi de qui est présent à
 * quel round, les joueurs s'arrangent entre eux (simplification actée 2026-08-23).
 */
export function extendSessionForLateJoiners(opts: ExtendSessionOptions): GroupBookingPlan["proposedBookings"] {
  const {
    session,
    lateJoinerIds,
    joinTime,
    targetDate,
    groupId,
    maxPlayersPerCourt,
    maxDailyReservationsPerPlayer,
    availabilityWindowHours,
    availableSlots,
    usedSessionIds,
    substituteQueue,
    existingDailyCounts,
    apiUserId,
    playSlotsDefaults,
    playerPlaySlots,
    warnings,
  } = opts;

  const rawMembers = [...session.members];
  for (const id of lateJoinerIds) {
    if (rawMembers.includes(id)) continue;
    if (rawMembers.length >= maxPlayersPerCourt) {
      warnings.push(`Court ${session.court} : impossible d'ajouter ${id} (plafond ${maxPlayersPerCourt} joueurs/court).`);
      continue;
    }
    rawMembers.push(id);
  }
  const members = orderMembersByDemand(rawMembers, playSlotsDefaults, playerPlaySlots);
  session.members = members;
  const roundsNeeded = computeRoundsNeededForMembers(members, playSlotsDefaults, playerPlaySlots);
  session.roundsNeeded = roundsNeeded;

  if (members.length > 2) {
    warnings.push(
      `Court ${session.court} : rotation à ${members.length} (${members.join(", ")}) — ${roundsNeeded} round(s) au total (les joueurs s'arrangent entre eux pour tourner).`,
    );
  }

  const groupSize = members.length === 3 ? 3 : 2;
  const added: GroupBookingPlan["proposedBookings"] = [];
  const allBookings = () => [...session.proposedBookings, ...added];
  let lastEnd = lastSlotEndTime(allBookings(), session.court) ?? joinTime;

  while (session.roundsBooked + added.length < roundsNeeded) {
    const nextBegin = nextSlotBeginTime(lastEnd);
    if (!nextBegin) break;
    if (!withinAvailabilityWindow(session.anchorStartTime, nextBegin, availabilityWindowHours)) {
      warnings.push(
        `Court ${session.court} : prolongation arrêtée à ${nextBegin} (hors fenêtre ${availabilityWindowHours}h depuis ${session.anchorStartTime}).`,
      );
      break;
    }

    const roundIndex = session.roundsBooked + added.length;
    const [i, j] = teamrNamesForRound(groupSize, roundIndex);
    let userId = members[i]!;
    let partnerId = members[j]!;

    let blocked = false;
    for (const role of ["userId", "partnerId"] as const) {
      const candidateId = role === "userId" ? userId : partnerId;
      if (candidateId === apiUserId) continue;
      const already = (existingDailyCounts[candidateId] ?? 0) + teamrCountForPlayer(allBookings(), candidateId);
      if (already < maxDailyReservationsPerPlayer) continue;

      const sub = substituteQueue.shift();
      if (sub) {
        if (role === "userId") userId = sub;
        else partnerId = sub;
        warnings.push(
          `Court ${session.court} : prolongation TeamR avec prête-nom ${sub} (${candidateId} au plafond ${maxDailyReservationsPerPlayer} résas/jour).`,
        );
      } else {
        warnings.push(
          `Court ${session.court} : impossible de prolonger — ${candidateId} au plafond ${maxDailyReservationsPerPlayer} résas/jour et aucun prête-nom disponible.`,
        );
        blocked = true;
      }
    }
    if (blocked) break;

    const slot = findSlotOnCourt(availableSlots, usedSessionIds, session.court, nextBegin);
    if (!slot) {
      warnings.push(`Court ${session.court} : pas de créneau libre à ${nextBegin} pour prolonger la rotation.`);
      break;
    }

    const startDate = slotStartDateIsoHeuristicParis(targetDate, slot.beginTime);
    if (!startDate) break;

    added.push({
      sessionId: slot.sessionId,
      userId,
      partnerId,
      startDate,
      court: session.court,
      slotTime: slot.beginTime,
      slotEndTime: slot.endTime,
      groupId,
    });
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
    if (session.members.length + orphanCount > maxPlayersPerCourt) continue;
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
