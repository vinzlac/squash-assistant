import { describe, expect, it } from "vitest";
import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import {
  computeShortfall,
  countPlayersInSessions,
  parseTeamrTime,
  splitByAvailabilityWindow,
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
