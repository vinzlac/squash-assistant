import { describe, expect, it } from "vitest";
import { simulateScenario, type ScenarioPlayerVote } from "./simulateScenario.js";
import type { BookingRule } from "../config.js";

function rule(overrides: Partial<BookingRule> = {}): BookingRule {
  return {
    id: "squashacademie-mardi",
    name: null,
    enabled: true,
    whatsappGroupJid: "group@test",
    resaSquashGroupId: "group-1",
    pollCron: "0 10 * * 2",
    decisionCron: "30 21 * * 2",
    targetWeekdayOffset: 7,
    candidateStartTimes: ["18H45"],
    maxCourtsPerSlot: 3,
    minPlayersPerCourt: 2,
    maxPlayersPerCourt: 2,
    maxReservationsPerPlayer: 1,
    priorityBookers: [],
    preferMinPlayersPerCourt: false,
    courtPriority: [4, 3, 2, 1],
    availabilityWindowHours: 3,
    description: null,
    substituteBookers: [],
    maxDailyReservationsPerPlayer: 2,
    unexpectedPlayersMargin: 0,
    reservationNotifyWhatsappGroupJid: null,
    cronJitterWindowMinutes: 60,
    ...overrides,
  };
}

describe("simulateScenario", () => {
  it("2 joueurs votent la même heure candidate : 1 réservation, court libre choisi", () => {
    const players: ScenarioPlayerVote[] = [
      { playerId: "a", vote: "18H45" },
      { playerId: "b", vote: "18H45" },
    ];
    const groups = simulateScenario(rule(), players, null);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.startTime).toBe("18H45");
    expect(groups[0]!.plan.proposedBookings).toEqual([
      expect.objectContaining({ userId: "a", partnerId: "b", slotTime: "18H45" }),
    ]);
  });

  it("un joueur qui vote \"prete-nom\" n'est jamais confirmé lui-même, seulement disponible comme substitut", () => {
    const players: ScenarioPlayerVote[] = [
      { playerId: "a", vote: "18H45" },
      { playerId: "b", vote: "18H45" },
      { playerId: "c", vote: "prete-nom" },
    ];
    const groups = simulateScenario(rule(), players, null);
    const allIds = groups.flatMap((g) => g.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId]));
    expect(allIds).not.toContain("c");
  });

  it("un joueur qui vote \"non\" n'apparaît jamais dans le plan", () => {
    const players: ScenarioPlayerVote[] = [
      { playerId: "a", vote: "18H45" },
      { playerId: "b", vote: "18H45" },
      { playerId: "c", vote: "non" },
    ];
    const groups = simulateScenario(rule(), players, null);
    const allIds = groups.flatMap((g) => g.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId]));
    expect(allIds).not.toContain("c");
  });

  it("2 heures candidates, 4 joueurs : deux plans distincts, courts synthétiques disponibles sur les deux", () => {
    const players: ScenarioPlayerVote[] = [
      { playerId: "a", vote: "18H45" },
      { playerId: "b", vote: "18H45" },
      { playerId: "c", vote: "19H30" },
      { playerId: "d", vote: "19H30" },
    ];
    const groups = simulateScenario(rule({ candidateStartTimes: ["18H45", "19H30"] }), players, null);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.plan.proposedBookings).toHaveLength(1);
    expect(groups[1]!.plan.proposedBookings).toHaveLength(1);
  });

  it("le titulaire (apiUserId) n'est jamais substitué même en jouant plus que maxDailyReservationsPerPlayer", () => {
    // stephane (non-titulaire) atteint le plafond dès le round 3 : sans prête-nom disponible pour
    // le couvrir, sa réservation serait ignorée — d'où le vote "prete-nom" de sebastien, qui le
    // remplace. Sans ce 3e joueur, seuls 2 créneaux seraient produits (round 3 ignoré, warning
    // explicite), pas 3 — ce n'est pas le titulaire qui manquerait de prête-nom, lui n'a aucun
    // plafond, c'est stephane.
    const players: ScenarioPlayerVote[] = [
      { playerId: "vincent", vote: "18H45" },
      { playerId: "stephane", vote: "18H45" },
      { playerId: "sebastien", vote: "prete-nom" },
    ];
    const groups = simulateScenario(
      rule({ candidateStartTimes: ["18H45"], maxReservationsPerPlayer: 3, maxDailyReservationsPerPlayer: 2 }),
      players,
      "vincent",
    );
    const bookings = groups[0]!.plan.proposedBookings;
    expect(bookings).toHaveLength(3);
    expect(bookings.every((b) => b.userId === "vincent")).toBe(true);
  });
});
