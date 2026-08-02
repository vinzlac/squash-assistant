import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import { SQUASH_COURT_COUNT, SQUASH_SLOT_MINUTES } from "./constants.js";
import { resolveCourtAssignments, type AvailableSlot, type ProposedSlot } from "./courtAssignment.js";
import { buildPairsForGroupBooking, type GroupBookingPair } from "./pairing.js";
import { courtsNeededForPlayers } from "./courtsNeeded.js";
import { formatTeamrTimeFromMinutes, parseTeamrTime, slotStartDateIsoHeuristicParis } from "./teamrTime.js";

export interface ComputeGroupBookingPlanInput {
  groupId: string;
  onDate: string;
  expectedPlayerIds: string[];
  substitutePlayerIds: string[];
  /** Objectif : chaque joueur doit apparaître sur au moins N créneaux 45 min. */
  slotsPerPlayer: number;
  maxCourts: number;
  preferMinPlayersPerCourt: boolean;
  courtPriority: number[];
  /** Heure candidate — plancher horaire (les créneaux avant cette heure sont ignorés). */
  startTime: string;
  /** Créneaux disponibles ce jour-là, tous courts confondus (déjà filtrés available === true). */
  availableSlots: AvailableSlot[];
  /** sessionId déjà retenus par une heure candidate précédente dans le même run — jamais reproposés. */
  usedSessionIds: ReadonlySet<string>;
  /** userId du titulaire de la clé API resa-squash — n'a lui-même aucun plafond de résas/jour (c'est son compte qui sert à tous les appels), toujours exclu du contrôle de quota. null si non connu/non applicable. */
  apiUserId: string | null;
  /** Nombre de résas déjà comptabilisées aujourd'hui par joueur (heures candidates précédentes du même job) — tout joueur autre que apiUserId est plafonné à maxDailyReservationsPerPlayer. */
  existingDailyCounts?: Readonly<Record<string, number>>;
  maxDailyReservationsPerPlayer: number;
}

function groupAvailableSlotsByTime(
  slots: AvailableSlot[],
  usedSessionIds: ReadonlySet<string>,
): Map<string, AvailableSlot[]> {
  const m = new Map<string, AvailableSlot[]>();
  for (const s of slots) {
    if (usedSessionIds.has(s.sessionId)) continue;
    const arr = m.get(s.beginTime) ?? [];
    arr.push(s);
    m.set(s.beginTime, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.court - b.court);
  return m;
}

function sortTimeKeys(times: Iterable<string>): string[] {
  return [...times].sort((a, b) => (parseTeamrTime(a) ?? 0) - (parseTeamrTime(b) ?? 0));
}

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

/** Nombre de courts distincts déjà occupés à un horaire donné, tous rounds/couches confondus. */
function courtsUsedAtTime(proposed: ProposedSlot[], slotTime: string): number {
  return new Set(proposed.filter((b) => b.slotTime === slotTime).map((b) => b.court)).size;
}

function playersBusyAtSlotTime(proposed: ProposedSlot[], slotTime: string, userId: string, partnerId: string): boolean {
  const want = new Set([userId, partnerId]);
  for (const b of proposed) {
    if (b.slotTime !== slotTime) continue;
    if (want.has(b.userId) || want.has(b.partnerId)) return true;
  }
  return false;
}

function countProposedSlotsForPlayer(proposed: ProposedSlot[], playerId: string): number {
  let n = 0;
  for (const b of proposed) if (b.userId === playerId || b.partnerId === playerId) n += 1;
  return n;
}

/**
 * Propose des réservations groupées (plusieurs paires, plusieurs courts, rounds successifs) pour
 * une heure candidate, en tenant compte des sessionId déjà retenus par une heure candidate
 * précédente du même run (usedSessionIds). Ne réserve rien : sortie prête pour reserve_slot.
 * Port fidèle de resa-squash (group-booking-plan.ts, planGroupBookingsMvp) — sans les vérifications
 * spécifiques à la config groupe resa-squash (appartenance, bornes DB, jour récurrent), sans objet
 * squash-assistant équivalent (voir design doc §5).
 */
export function computeGroupBookingPlan(input: ComputeGroupBookingPlanInput): GroupBookingPlan {
  const warnings: string[] = [];

  const { pairs, rotatingPlayerIds, remainingSubstituteIds } = buildPairsForGroupBooking(
    input.expectedPlayerIds,
    input.substitutePlayerIds,
  );
  const rotatingSet = new Set(rotatingPlayerIds);
  const substituteQueue = [...remainingSubstituteIds];
  if (rotatingPlayerIds.length > 0) {
    warnings.push(
      `Effectif impair : rotation sur court sans ligne TeamR pour id(s) : ${rotatingPlayerIds.join(", ")} (convention : dernier joueur dans expectedPlayerIds après dédoublonnage — un prête-nom n'est jamais utilisé pour compléter l'effectif).`,
    );
  }

  const playerSet = new Set<string>();
  for (const p of pairs) {
    playerSet.add(p.userId);
    playerSet.add(p.partnerId);
  }
  for (const r of rotatingPlayerIds) playerSet.add(r);

  const courtsNeededRaw = courtsNeededForPlayers(playerSet.size, input.preferMinPlayersPerCourt);
  const hardCap = Math.min(SQUASH_COURT_COUNT, input.maxCourts);
  const courtsNeeded = Math.min(courtsNeededRaw, hardCap);
  if (courtsNeededRaw > hardCap) {
    warnings.push(`Il faudrait ${courtsNeededRaw} court(s) ; plafond ${hardCap} — plan tronqué.`);
  }

  const startMinutes = parseTeamrTime(input.startTime);
  const filteredSlots =
    startMinutes == null
      ? input.availableSlots
      : input.availableSlots.filter((s) => {
          const m = parseTeamrTime(s.beginTime);
          return m == null || m >= startMinutes;
        });

  const byTime = groupAvailableSlotsByTime(filteredSlots, input.usedSessionIds);
  const sortedTimes = sortTimeKeys(byTime.keys());
  const emptyMeta = {
    courtsNeeded,
    roundsPlanned: 0,
    dryRun: true,
    groupLabel: input.groupId,
    recurringWeekday: new Date(input.onDate).getDay(),
    recurringStartTime: input.startTime,
    slotsPerPlayer: input.slotsPerPlayer,
    groupMinSlotsPerPlayer: input.slotsPerPlayer,
    groupMaxSlotsPerPlayer: input.slotsPerPlayer,
    pairCount: pairs.length,
    rotatingPlayerIds: [...rotatingPlayerIds],
  };
  if (sortedTimes.length === 0) {
    warnings.push("Aucun créneau libre après filtres (heure ciblée / dispos resa-squash).");
    return { dryRun: true, proposedBookings: [], warnings, meta: emptyMeta };
  }

  const proposed: ProposedSlot[] = [];
  const proposedWithMeta: GroupBookingPlan["proposedBookings"] = [];
  const claimedThisCall = new Set<string>();
  let totalRounds = 0;
  const maxRoundsPerLayer = Math.min(8, Math.max(pairs.length * 2, 4));

  planLayers: for (let layer = 0; layer < input.slotsPerPlayer; layer += 1) {
    const usedTimes = new Set<string>();
    let pairCursor = 0;
    let layerRounds = 0;

    while (pairCursor < pairs.length && layerRounds < maxRoundsPerLayer) {
      const remainingPairs = pairs.length - pairCursor;
      const maxCourtsThisRound = Math.min(courtsNeeded, remainingPairs);

      let tKey: string | null = null;
      let assignments: ReturnType<typeof resolveCourtAssignments> = null;

      // Cherche d'abord la taille de round maximale (courtsNeeded), puis réduit si aucun horaire ne
      // peut l'accueillir sans dépasser courtsNeeded courts SIMULTANÉS déjà occupés (toutes couches
      // confondues) — évite qu'un round « débordé » vers un horaire plus tardif se cumule avec le
      // round normal d'une autre couche au même horaire et dépasse le plafond de courts (2026-08-02).
      sizeSearch: for (let size = maxCourtsThisRound; size >= 1; size -= 1) {
        const candidatePairs = pairs.slice(pairCursor, pairCursor + size);
        const triedTimes = new Set<string>();
        const maxTimeSkips = sortedTimes.length + 2;
        for (let skip = 0; skip < maxTimeSkips; skip += 1) {
          let candidateTKey: string | null = null;
          for (const t of sortedTimes) {
            if (usedTimes.has(t) || triedTimes.has(t)) continue;
            if (availableSlotsAtTime(byTime, t, claimedThisCall).length < size) continue;
            candidateTKey = t;
            break;
          }
          if (!candidateTKey) break;
          triedTimes.add(candidateTKey);
          if (courtsUsedAtTime(proposed, candidateTKey) + size > courtsNeeded) continue;
          const pr0 = candidatePairs[0];
          if (pr0 && playersBusyAtSlotTime(proposed, candidateTKey, pr0.userId, pr0.partnerId)) continue;
          const available = availableSlotsAtTime(byTime, candidateTKey, claimedThisCall);
          let nextSlotCourts: Set<number> | null = null;
          if (layer + 1 < input.slotsPerPlayer) {
            const minM = parseTeamrTime(candidateTKey);
            const nextLabel = minM != null ? formatTeamrTimeFromMinutes(minM + SQUASH_SLOT_MINUTES) : null;
            if (nextLabel && byTime.has(nextLabel)) {
              nextSlotCourts = new Set(availableSlotsAtTime(byTime, nextLabel, claimedThisCall).map((s) => s.court));
            }
          }
          const attempt = resolveCourtAssignments(available, candidatePairs, proposed, input.courtPriority, nextSlotCourts);
          if (!attempt) continue;
          tKey = candidateTKey;
          assignments = attempt;
          break sizeSearch;
        }
      }

      if (!tKey || !assignments) {
        warnings.push(
          `Couche ${layer + 1}/${input.slotsPerPlayer} (objectif ≥${input.slotsPerPlayer} créneaux 45 min / joueur) : pas assez de courts libres à un horaire utilisable (${pairCursor}/${pairs.length} paires placées).`,
        );
        break planLayers;
      }

      for (const { pair: pr, slot } of assignments) {
        const startDate = slotStartDateIsoHeuristicParis(input.onDate, slot.beginTime);
        if (!startDate) {
          pairCursor += 1;
          continue;
        }

        const pairUserId = pr.userId;
        const pairPartnerId = pr.partnerId;
        let userId = pr.userId;
        let partnerId = pr.partnerId;

        let pairSkipped = false;
        for (const slotKey of ["userId", "partnerId"] as const) {
          const candidateId = slotKey === "userId" ? userId : partnerId;
          // Le titulaire de la clé API n'a lui-même aucun plafond — jamais contrôlé ni substitué.
          if (!candidateId || candidateId === input.apiUserId) continue;
          const existing = input.existingDailyCounts?.[candidateId] ?? 0;
          const already = existing + proposed.filter((b) => b.userId === candidateId || b.partnerId === candidateId).length;
          if (already < input.maxDailyReservationsPerPlayer) continue;

          const sub = substituteQueue.shift();
          if (sub) {
            if (slotKey === "userId") userId = sub;
            else partnerId = sub;
            warnings.push(
              `${candidateId} : plafond ${input.maxDailyReservationsPerPlayer} résas ce jour atteint — remplacé par le prête-nom ${sub} pour cette paire (${slot.beginTime}).`,
            );
          } else {
            warnings.push(
              `${candidateId} : plafond ${input.maxDailyReservationsPerPlayer} résas ce jour atteint — réservation ignorée pour cette paire (${slot.beginTime}), aucun prête-nom disponible.`,
            );
            pairSkipped = true;
            break;
          }
        }
        if (pairSkipped) {
          pairCursor += 1;
          continue;
        }

        const proposedSlot: ProposedSlot = {
          userId,
          partnerId,
          court: slot.court,
          slotTime: slot.beginTime,
          slotEndTime: slot.endTime,
          pairUserId,
          pairPartnerId,
        };
        proposed.push(proposedSlot);
        proposedWithMeta.push({
          sessionId: slot.sessionId,
          userId,
          partnerId,
          startDate,
          court: slot.court,
          slotTime: slot.beginTime,
          slotEndTime: slot.endTime,
          groupId: input.groupId,
        });
        claimedThisCall.add(slot.sessionId);
        pairCursor += 1;
      }

      usedTimes.add(tKey);
      layerRounds += 1;
      totalRounds += 1;

      if (pairCursor >= pairs.length) break;
    }

    if (pairCursor < pairs.length) {
      warnings.push(
        `Couche ${layer + 1}/${input.slotsPerPlayer} : ${pairs.length - pairCursor} paire(s) non placée(s) dans cette couche.`,
      );
      break;
    }
  }

  for (const pid of playerSet) {
    if (rotatingSet.has(pid)) continue;
    const n = countProposedSlotsForPlayer(proposed, pid);
    if (n < input.slotsPerPlayer) {
      warnings.push(
        `Objectif : chaque joueur ≥${input.slotsPerPlayer} créneau(x) TeamR de ${SQUASH_SLOT_MINUTES} min — id ${pid} : ${n} réservation(s) proposée(s).`,
      );
    }
  }

  return {
    dryRun: true,
    proposedBookings: proposedWithMeta,
    warnings,
    meta: { ...emptyMeta, roundsPlanned: totalRounds },
  };
}
