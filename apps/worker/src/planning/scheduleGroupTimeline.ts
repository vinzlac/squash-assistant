import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import { orderByCourtPriority, type AvailableSlot } from "./courtAssignment.js";
import { teamrNamesForRound, type Group } from "./groups.js";
import { parseTeamrTime, slotStartDateIsoHeuristicParis } from "./teamrTime.js";
import { formatPairReplacement, resolveBookablePair } from "./jokerSubstitution.js";

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

    // Deux causes rendent un joueur inapte à porter une ligne TeamR, traitées ensemble :
    // pas réinscrit (resa-squash ADR-011) ou au plafond « maison » de résas/jour (ADR-016).
    // Prête-noms d'abord, joker en dernier recours et en partenaire seulement (ADR-024).
    const causes = new Map<string, string>();
    for (const id of unregisteredPlayerIds ?? []) causes.set(id, "pas réinscrit pour la saison");
    for (const candidateId of [userId, partnerId]) {
      if (causes.has(candidateId)) continue;
      const already =
        (existingDailyCounts[candidateId] ?? 0) +
        bookings.filter((b) => b.userId === candidateId || b.partnerId === candidateId).length;
      if (already >= maxDailyReservationsPerPlayer) {
        causes.set(candidateId, `plafond ${maxDailyReservationsPerPlayer} résas ce jour atteint`);
      }
    }
    const blockedIds = new Set(causes.keys());

    if ([userId, partnerId].some((id) => blockedIds.has(id))) {
      const resolved = resolveBookablePair({
        userId,
        partnerId,
        blockedIds,
        substituteQueue,
        jokerBookerId: jokerBookerId ?? null,
      });
      if (!resolved) {
        const blame = [userId, partnerId].filter((id) => blockedIds.has(id));
        warnings.push(
          `${blame.join(", ")} : ${causes.get(blame[0]!)} — réservation ignorée pour cette paire (${slot.beginTime}), aucun prête-nom disponible${jokerBookerId ? " et joker déjà mobilisé sur cette ligne" : " et aucun joker configuré sur la règle"}.`,
        );
        continue;
      }
      userId = resolved.userId;
      partnerId = resolved.partnerId;
      for (const r of resolved.replacements) {
        warnings.push(formatPairReplacement(r, causes.get(r.replaced) ?? "indisponible pour réserver", slot.beginTime));
      }
    }

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
