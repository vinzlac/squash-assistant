import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import { orderByCourtPriority, type AvailableSlot } from "./courtAssignment.js";
import { teamrNamesForRound, type Group } from "./groups.js";
import { parseTeamrTime, slotStartDateIsoHeuristicParis } from "./teamrTime.js";
import { applyJokerToPair } from "./jokerSubstitution.js";

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
  /** Joueurs non réinscrits (resa-squash ADR-011) — leur ligne TeamR passe au joker. */
  unregisteredPlayerIds?: ReadonlySet<string>;
  /** Joker de la règle — toujours en partenaire, sans plafond de résas/jour (ADR-024). */
  jokerBookerId?: string | null;
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
    unregisteredPlayerIds,
    jokerBookerId,
    existingDailyCounts,
    maxDailyReservationsPerPlayer,
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

    // Joueur non réinscrit : sa ligne TeamR passe au joker dès le plan — il joue quand même,
    // seul le nom porté par la réservation change (ADR-024).
    const unregistered = unregisteredPlayerIds ?? new Set<string>();
    const blockedByRegistration = [userId, partnerId].filter((id) => unregistered.has(id));
    if (blockedByRegistration.length > 0) {
      const withJoker = applyJokerToPair({
        userId,
        partnerId,
        jokerBookerId: jokerBookerId ?? null,
        unregisteredPlayerIds: unregistered,
      });
      if (withJoker) {
        userId = withJoker.userId;
        partnerId = withJoker.partnerId;
        warnings.push(
          `${withJoker.replaced} : pas réinscrit pour la saison — réservation au nom du joker ${jokerBookerId} pour cette paire (${slot.beginTime}).`,
        );
      } else {
        warnings.push(
          jokerBookerId
            ? `${blockedByRegistration.join(", ")} : pas réinscrit(s) — aucun titulaire réinscrit dans cette paire, réservation ignorée (${slot.beginTime}).`
            : `${blockedByRegistration.join(", ")} : pas réinscrit(s) — réservation ignorée (${slot.beginTime}), aucun joker configuré sur la règle.`,
        );
        continue;
      }
    }

    for (const role of ["userId", "partnerId"] as const) {
      const candidateId = role === "userId" ? userId : partnerId;
      // Le joker (gérant du club) n'a pas de plafond : le soumettre au contrôle le ferait
      // remplacer par un prête-nom au bout de 2 lignes.
      if (jokerBookerId && candidateId === jokerBookerId) continue;
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
