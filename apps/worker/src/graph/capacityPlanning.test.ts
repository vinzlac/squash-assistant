import { describe, expect, it } from "vitest";
import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import {
  busyCourtsDuring,
  computeShortfall,
  conflictingSessionIds,
  countPlayersInSessions,
  courtIntervalsFromPlan,
  parseTeamrTime,
  splitByAvailabilityWindow,
  type CourtInterval,
} from "./capacityPlanning.js";

function plan(overrides: Partial<GroupBookingPlan> = {}): GroupBookingPlan {
  return {
    dryRun: true,
    proposedBookings: [],
    warnings: [],
    meta: {
      courtsNeeded: 1,
      roundsPlanned: 1,
      dryRun: true,
      groupLabel: "test",
      recurringWeekday: 1,
      recurringStartTime: "18H45",
      slotsPerPlayer: 2,
      groupMinSlotsPerPlayer: 2,
      groupMaxSlotsPerPlayer: 3,
      pairCount: 3,
    },
    ...overrides,
  };
}

describe("parseTeamrTime", () => {
  it("parse une heure TeamR en minutes depuis minuit", () => {
    expect(parseTeamrTime("18H45")).toBe(18 * 60 + 45);
    expect(parseTeamrTime("9H00")).toBe(9 * 60);
  });

  it("retourne null sur un format invalide", () => {
    expect(parseTeamrTime("18:45")).toBeNull();
    expect(parseTeamrTime("n'importe quoi")).toBeNull();
  });
});

describe("computeShortfall", () => {
  it("0 quand le plan a placé tout le monde (pairCount × slotsPerPlayer atteint)", () => {
    const p = plan({
      proposedBookings: [
        { sessionId: "s1", court: 1, userId: "a", partnerId: "b", slotTime: "18H45", slotEndTime: "19H30" },
        { sessionId: "s2", court: 1, userId: "a", partnerId: "b", slotTime: "19H30", slotEndTime: "20H15" },
      ],
      meta: { ...plan().meta, pairCount: 1, slotsPerPlayer: 2 },
    });
    expect(computeShortfall(p)).toBe(0);
  });

  it("compte les réservations manquantes par rapport à l'objectif", () => {
    const p = plan({
      proposedBookings: [
        { sessionId: "s1", court: 1, userId: "a", partnerId: "b", slotTime: "18H45", slotEndTime: "19H30" },
      ],
      meta: { ...plan().meta, pairCount: 3, slotsPerPlayer: 2 }, // objectif 6, seulement 1 placée
    });
    expect(computeShortfall(p)).toBe(5);
  });
});

describe("splitByAvailabilityWindow", () => {
  it("garde dans la fenêtre les créneaux avant le cutoff", () => {
    const p = plan({
      proposedBookings: [
        { sessionId: "s1", court: 1, userId: "a", partnerId: "b", slotTime: "18H45", slotEndTime: "19H30" },
        { sessionId: "s2", court: 2, userId: "c", partnerId: "d", slotTime: "20H15", slotEndTime: "21H00" },
      ],
    });
    // Fenêtre de 3h après 18H45 → cutoff 21H45 : les 2 réservations sont dans la fenêtre.
    const { outOfWindowSessionIds } = splitByAvailabilityWindow(p, "18H45", 3);
    expect(outOfWindowSessionIds).toEqual([]);
  });

  it("exclut les créneaux au-delà de la fenêtre acceptée", () => {
    const p = plan({
      proposedBookings: [
        { sessionId: "s1", court: 1, userId: "a", partnerId: "b", slotTime: "18H45", slotEndTime: "19H30" },
        { sessionId: "s2", court: 2, userId: "c", partnerId: "d", slotTime: "22H30", slotEndTime: "23H15" },
      ],
    });
    // Fenêtre de 3h après 18H45 → cutoff 21H45 : 22H30 est hors fenêtre.
    const { outOfWindowSessionIds } = splitByAvailabilityWindow(p, "18H45", 3);
    expect(outOfWindowSessionIds).toEqual(["s2"]);
  });
});

describe("countPlayersInSessions", () => {
  it("compte 2 joueurs pour une réservation à 2, 1 pour une réservation en rotation seule", () => {
    const p = plan({
      proposedBookings: [
        { sessionId: "s1", court: 1, userId: "a", partnerId: "b", slotTime: "18H45", slotEndTime: "19H30" },
        { sessionId: "s2", court: 2, userId: "c", slotTime: "18H45", slotEndTime: "19H30" },
      ],
    });
    expect(countPlayersInSessions(p, ["s1", "s2"])).toBe(3);
  });

  it("ignore les sessionIds non présents dans le plan", () => {
    const p = plan({
      proposedBookings: [
        { sessionId: "s1", court: 1, userId: "a", partnerId: "b", slotTime: "18H45", slotEndTime: "19H30" },
      ],
    });
    expect(countPlayersInSessions(p, ["s-inconnu"])).toBe(0);
  });
});

// Cas rapporté : 18H45 (Vincent+Stéphane sur le court 4, 2 rounds 18H45-20H15) et
// 19H30 (Martin+Tin sur le court 4, 19H30-21H00) sont deux appels plan_group_bookings
// indépendants qui choisissent chacun le court 4 sans se voir l'un l'autre — conflit
// sur le créneau 19H30-20H15 du court 4.
describe("courtIntervalsFromPlan / conflictingSessionIds / busyCourtsDuring — conflit de court entre deux heures candidates", () => {
  const plan1845 = plan({
    proposedBookings: [
      { sessionId: "s-1845-r1", court: 4, userId: "vincent", partnerId: "stephane", slotTime: "18H45", slotEndTime: "19H30" },
      { sessionId: "s-1845-r2", court: 4, userId: "vincent", partnerId: "stephane", slotTime: "19H30", slotEndTime: "20H15" },
    ],
    meta: { ...plan().meta, pairCount: 1, slotsPerPlayer: 2 },
  });

  const plan1930 = plan({
    proposedBookings: [
      { sessionId: "s-1930-r1", court: 4, userId: "martin", partnerId: "tin", slotTime: "19H30", slotEndTime: "20H15" },
      { sessionId: "s-1930-r2", court: 4, userId: "martin", partnerId: "tin", slotTime: "20H15", slotEndTime: "21H00" },
    ],
    meta: { ...plan().meta, pairCount: 1, slotsPerPlayer: 2 },
  });

  it("courtIntervalsFromPlan convertit les réservations retenues en intervalles d'occupation", () => {
    const intervals = courtIntervalsFromPlan(plan1845);
    expect(intervals).toEqual([
      { court: 4, startMinutes: 18 * 60 + 45, endMinutes: 19 * 60 + 30 },
      { court: 4, startMinutes: 19 * 60 + 30, endMinutes: 20 * 60 + 15 },
    ] satisfies CourtInterval[]);
  });

  it("courtIntervalsFromPlan exclut les sessionIds passés en excludeSessionIds", () => {
    const intervals = courtIntervalsFromPlan(plan1845, new Set(["s-1845-r2"]));
    expect(intervals).toEqual([{ court: 4, startMinutes: 18 * 60 + 45, endMinutes: 19 * 60 + 30 }]);
  });

  it("busyCourtsDuring détecte le court 4 comme occupé sur la fenêtre 19H30-21H00 de la 2e heure candidate", () => {
    const occupied = courtIntervalsFromPlan(plan1845);
    const busy = busyCourtsDuring(occupied, 19 * 60 + 30, 21 * 60);
    expect(busy).toEqual([4]);
  });

  it("busyCourtsDuring ne signale rien si aucune plage ne chevauche", () => {
    const occupied = courtIntervalsFromPlan(plan1845);
    const busy = busyCourtsDuring(occupied, 21 * 60, 22 * 60 + 30);
    expect(busy).toEqual([]);
  });

  it("conflictingSessionIds détecte le double-booking exact du bug rapporté (court 4, 19H30-20H15)", () => {
    const occupied = courtIntervalsFromPlan(plan1845);
    const conflicts = conflictingSessionIds(plan1930, occupied);
    expect(conflicts).toEqual(["s-1930-r1"]);
  });

  it("conflictingSessionIds ne signale pas de conflit sur un court différent", () => {
    const occupied = courtIntervalsFromPlan(plan1845);
    const planOtherCourt = plan({
      proposedBookings: [
        { sessionId: "s-court3", court: 3, userId: "terence", partnerId: "sebastien", slotTime: "19H30", slotEndTime: "20H15" },
      ],
    });
    expect(conflictingSessionIds(planOtherCourt, occupied)).toEqual([]);
  });

  it("conflictingSessionIds ne signale pas de conflit quand les plages ne se chevauchent pas", () => {
    const occupied = courtIntervalsFromPlan(plan1845);
    const planLater = plan({
      proposedBookings: [
        { sessionId: "s-later", court: 4, userId: "x", partnerId: "y", slotTime: "20H15", slotEndTime: "21H00" },
      ],
    });
    expect(conflictingSessionIds(planLater, occupied)).toEqual([]);
  });
});
