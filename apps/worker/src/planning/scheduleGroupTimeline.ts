import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import { orderByCourtPriority, type AvailableSlot } from "./courtAssignment.js";
import { teamrNamesForRound, type Group } from "./groups.js";
import { parseTeamrTime, slotStartDateIsoHeuristicParis } from "./teamrTime.js";

function availableSlotsAtTime(
  byTime: Map<string, AvailableSlot[]>,
  timeKey: string,
  claimedThisCall: ReadonlySet<string>,
): AvailableSlot[] {
  const at = byTime.get(timeKey);
  if (!at) return [];
  const byCourt = new Map<number, AvailableSlot>();
  for (const s of at) {
    if (claimedThisCall.has(s.sessionId)) continue;
    if (!byCourt.has(s.court)) byCourt.set(s.court, s);
  }
  return [...byCourt.values()];
}

export interface ScheduleGroupTimelineOptions {
  group: Group;
  /** Heure candidate — plancher horaire (les créneaux avant cette heure sont ignorés). */
  startTime: string;
  onDate: string;
  groupId: string;
  byTime: Map<string, AvailableSlot[]>;
  sortedTimes: string[];
  /** sessionId déjà retenus (par ce groupe ou un précédent dans le même appel) — mutée. */
  claimedThisCall: Set<string>;
  courtPriority: number[];
  /** Prête-noms disponibles — mutée à la consommation. */
  substituteQueue: string[];
  existingDailyCounts: Readonly<Record<string, number>>;
  maxDailyReservationsPerPlayer: number;
  apiUserId: string | null;
  warnings: string[];
}

/**
 * Réserve les `group.roundsNeeded` rounds d'un groupe (2 ou 3 joueurs) sur une timeline continue :
 * un seul court, conservé sur toute la durée (continuité), aux horaires disponibles à partir de
 * `startTime`. Nommage TeamR par round via un cycle round-robin fixe (`teamrNamesForRound`) — le
 * moteur ne calcule pas qui est physiquement présent à quel round, les joueurs s'arrangent entre
 * eux une fois le court réservé (simplification actée 2026-08-23).
 */
export function scheduleGroupTimeline(opts: ScheduleGroupTimelineOptions): GroupBookingPlan["proposedBookings"] {
  const {
    group,
    startTime,
    onDate,
    groupId,
    byTime,
    sortedTimes,
    claimedThisCall,
    courtPriority,
    substituteQueue,
    existingDailyCounts,
    maxDailyReservationsPerPlayer,
    apiUserId,
    warnings,
  } = opts;

  const bookings: GroupBookingPlan["proposedBookings"] = [];
  const startMinutes = parseTeamrTime(startTime) ?? 0;
  const timesFrom = sortedTimes.filter((t) => (parseTeamrTime(t) ?? 0) >= startMinutes);
  const groupSize = group.members.length === 3 ? 3 : 2;
  let assignedCourt: number | null = null;

  for (const t of timesFrom) {
    if (bookings.length >= group.roundsNeeded) break;

    const available = availableSlotsAtTime(byTime, t, claimedThisCall);
    if (available.length === 0) continue;

    const continuityMatch: AvailableSlot | undefined =
      assignedCourt != null ? available.find((s) => s.court === assignedCourt) : undefined;
    const slot: AvailableSlot | undefined = continuityMatch ?? orderByCourtPriority(available, courtPriority)[0];
    if (!slot) continue;

    const roundIndex = bookings.length;
    const [i, j] = teamrNamesForRound(groupSize, roundIndex);
    let userId = group.members[i]!;
    let partnerId = group.members[j]!;

    let blocked = false;
    for (const role of ["userId", "partnerId"] as const) {
      const candidateId = role === "userId" ? userId : partnerId;
      if (candidateId === apiUserId) continue;
      const already =
        (existingDailyCounts[candidateId] ?? 0) +
        bookings.filter((b) => b.userId === candidateId || b.partnerId === candidateId).length;
      if (already < maxDailyReservationsPerPlayer) continue;

      const sub = substituteQueue.shift();
      if (sub) {
        if (role === "userId") userId = sub;
        else partnerId = sub;
        warnings.push(
          `${candidateId} : plafond ${maxDailyReservationsPerPlayer} résas ce jour atteint — remplacé par le prête-nom ${sub} pour cette paire (${slot.beginTime}).`,
        );
      } else {
        warnings.push(
          `${candidateId} : plafond ${maxDailyReservationsPerPlayer} résas ce jour atteint — réservation ignorée pour cette paire (${slot.beginTime}), aucun prête-nom disponible.`,
        );
        blocked = true;
      }
    }
    if (blocked) continue;

    const startDate = slotStartDateIsoHeuristicParis(onDate, slot.beginTime);
    if (!startDate) continue;

    bookings.push({
      sessionId: slot.sessionId,
      userId,
      partnerId,
      startDate,
      court: slot.court,
      slotTime: slot.beginTime,
      slotEndTime: slot.endTime,
      groupId,
    });
    claimedThisCall.add(slot.sessionId);
    assignedCourt = slot.court;
  }

  if (bookings.length < group.roundsNeeded) {
    warnings.push(
      `Groupe ${group.members.join("+")} : ${bookings.length}/${group.roundsNeeded} round(s) réservé(s) — créneaux insuffisants à partir de ${startTime}.`,
    );
  }

  return bookings;
}
