import { SQUASH_COURT_COUNT, SQUASH_SLOT_MINUTES } from "./constants.js";
import { formatTeamrTimeFromMinutes, parseTeamrTime } from "./teamrTime.js";
import { planJobBookings } from "./planJob.js";
import type { AvailableSlot } from "./courtAssignment.js";
import type { BookingRule } from "../config.js";
import type { BookingPlanGroup } from "../graph/state.js";

export interface ScenarioPlayerVote {
  playerId: string;
  /** Une heure candidate de la règle, "prete-nom", ou "non". */
  vote: string;
}

/** Date arbitraire fixe — jamais utilisée pour une vraie réservation (simulation uniquement). */
const SIMULATION_DATE = "2026-01-06";

function synthesizeAvailableSlots(candidateStartTimes: string[], maxReservationsPerPlayer: number): AvailableSlot[] {
  const slots: AvailableSlot[] = [];
  let seq = 0;
  for (const startTime of candidateStartTimes) {
    const startMinutes = parseTeamrTime(startTime);
    if (startMinutes == null) continue;
    for (let round = 0; round < maxReservationsPerPlayer; round += 1) {
      const beginMinutes = startMinutes + round * SQUASH_SLOT_MINUTES;
      const beginTime = formatTeamrTimeFromMinutes(beginMinutes);
      const endTime = formatTeamrTimeFromMinutes(beginMinutes + SQUASH_SLOT_MINUTES);
      for (let court = 1; court <= SQUASH_COURT_COUNT; court += 1) {
        seq += 1;
        slots.push({ sessionId: `sim-${seq}`, court, beginTime, endTime });
      }
    }
  }
  return slots;
}

function deriveVotes(
  candidateStartTimes: string[],
  players: ScenarioPlayerVote[],
): { confirmedPlayerIdsByTime: Record<string, string[]>; volunteerSubstituteIds: string[] } {
  const confirmedPlayerIdsByTime: Record<string, string[]> = {};
  for (const time of candidateStartTimes) confirmedPlayerIdsByTime[time] = [];
  const volunteerSubstituteIds: string[] = [];
  for (const { playerId, vote } of players) {
    if (vote === "prete-nom") {
      volunteerSubstituteIds.push(playerId);
    } else if (confirmedPlayerIdsByTime[vote]) {
      confirmedPlayerIdsByTime[vote]!.push(playerId);
    }
  }
  return { confirmedPlayerIdsByTime, volunteerSubstituteIds };
}

/**
 * Calcule le plan pour un scénario simulé : disponibilité synthétique "tout libre" (assez de
 * créneaux pour couvrir maxReservationsPerPlayer rounds par heure candidate, sur
 * SQUASH_COURT_COUNT courts), votes dérivés directement des joueurs du scénario (pas de sondage
 * réel). Appelle planJobBookings — le même code que le nœud de production bookSlots.ts.
 */
export function simulateScenario(
  rule: BookingRule,
  players: ScenarioPlayerVote[],
  apiUserId: string | null,
): BookingPlanGroup[] {
  const availableSlots = synthesizeAvailableSlots(rule.candidateStartTimes, rule.maxReservationsPerPlayer);
  const { confirmedPlayerIdsByTime, volunteerSubstituteIds } = deriveVotes(rule.candidateStartTimes, players);
  return planJobBookings(rule, SIMULATION_DATE, confirmedPlayerIdsByTime, volunteerSubstituteIds, availableSlots, apiUserId);
}
