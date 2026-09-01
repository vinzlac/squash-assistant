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
    requireTelegramGoForAutoJobs: true,
    nextDayReminderEnabled: false,
    jokerBookerId: null,
    ...overrides,
  };
}

describe("simulateScenario", () => {
  it("2 joueurs votent la même heure candidate : 1 réservation, court libre choisi", () => {
    const players: ScenarioPlayerVote[] = [
      { playerId: "a", vote: "18H45" },
      { playerId: "b", vote: "18H45" },
    ];
    const groups = simulateScenario(rule(), players, null, {
      defaults: { defaultMinPlaySlots: 1, defaultMaxPlaySlots: 1 },
    });
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
    const groups = simulateScenario(rule({ candidateStartTimes: ["18H45", "19H30"] }), players, null, {
      defaults: { defaultMinPlaySlots: 1, defaultMaxPlaySlots: 1 },
    });
    expect(groups).toHaveLength(2);
    expect(groups[0]!.plan.proposedBookings).toHaveLength(1);
    expect(groups[1]!.plan.proposedBookings).toHaveLength(1);
  });

  it("le titulaire (apiUserId) est substitué comme n'importe quel joueur au-delà de maxDailyReservationsPerPlayer (bugfix 2026-08-27)", () => {
    // vincent (titulaire) ET stephane sont nommés ensemble à chaque round (paire de 2 — toujours
    // présents tous les deux) et visent 3 rounds (playSlotsOptions) : au round 3, les DEUX ont déjà
    // 2 réservations chacun (plafond maxDailyReservationsPerPlayer=2), donc les DEUX ont besoin d'un
    // prête-nom simultanément — d'où 2 votes "prete-nom" (sebastien, julien), pas 1. Avant le fix,
    // vincent n'aurait jamais été plafonné ; maintenant il l'est comme stephane.
    const players: ScenarioPlayerVote[] = [
      { playerId: "vincent", vote: "18H45" },
      { playerId: "stephane", vote: "18H45" },
      { playerId: "sebastien", vote: "prete-nom" },
      { playerId: "julien", vote: "prete-nom" },
    ];
    const groups = simulateScenario(
      rule({ candidateStartTimes: ["18H45"], maxReservationsPerPlayer: 3, maxDailyReservationsPerPlayer: 2 }),
      players,
      "vincent",
      { defaults: { defaultMinPlaySlots: 3, defaultMaxPlaySlots: 3 } },
    );
    const bookings = groups[0]!.plan.proposedBookings;
    expect(bookings).toHaveLength(3);
    expect(bookings.slice(0, 2)).toEqual([
      expect.objectContaining({ userId: "vincent", partnerId: "stephane" }),
      expect.objectContaining({ userId: "vincent", partnerId: "stephane" }),
    ]);
    // 3e round : ni vincent ni stephane ne réapparaissent, les deux ont atteint leur plafond.
    expect(bookings[2]!.userId).not.toBe("vincent");
    expect(bookings[2]!.partnerId).not.toBe("stephane");
  });
});
