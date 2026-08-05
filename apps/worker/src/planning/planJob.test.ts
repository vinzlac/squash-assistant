import { describe, expect, it } from "vitest";
import { planJobBookings } from "./planJob.js";
import type { AvailableSlot } from "./courtAssignment.js";
import type { BookingRule } from "../config.js";

function rule(overrides: Partial<BookingRule> = {}): BookingRule {
  return {
    id: "squash-samedi-matin",
    name: null,
    enabled: true,
    whatsappGroupJid: "group@test",
    resaSquashGroupId: "group-1",
    pollCron: "0 10 * * 6",
    decisionCron: "30 21 * * 5",
    targetWeekdayOffset: 1,
    candidateStartTimes: ["10H30"],
    maxCourtsPerSlot: 3,
    minPlayersPerCourt: 2,
    maxPlayersPerCourt: 3,
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
    ...overrides,
  };
}

function makeSlots(courts: number[], beginTime: string, endTime: string): AvailableSlot[] {
  return courts.map((court) => ({ sessionId: `s-${court}-${beginTime}`, court, beginTime, endTime }));
}

describe("planJobBookings — marge joueurs imprévus", () => {
  it("marge à 0 (défaut) : comportement inchangé, pas de joueur ajouté", () => {
    const availableSlots = makeSlots([1, 2], "10H30", "11H15");
    const groups = planJobBookings(
      rule({ unexpectedPlayersMargin: 0 }),
      "2026-08-08",
      { "10H30": ["a", "b"] },
      [],
      availableSlots,
      null,
    );
    expect(groups[0]!.plan.proposedBookings).toEqual([
      expect.objectContaining({ userId: "a", partnerId: "b" }),
    ]);
  });

  it("marge à 1 : un joueur supplémentaire (issu de substituteBookers) est traité comme un vrai confirmé sur l'heure ayant des confirmés", () => {
    const availableSlots = makeSlots([1, 2], "10H30", "11H15");
    const groups = planJobBookings(
      rule({ unexpectedPlayersMargin: 1, substituteBookers: ["sebastien"] }),
      "2026-08-08",
      { "10H30": ["a", "b", "c"] },
      [],
      availableSlots,
      null,
    );
    // a+b, c+sebastien (sebastien traité comme confirmé, pas comme prête-nom de repli).
    expect(groups[0]!.plan.proposedBookings).toHaveLength(2);
    const allIds = groups[0]!.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId]);
    expect(allIds).toContain("sebastien");
    expect(groups[0]!.plan.warnings.some((w) => w.includes("Effectif impair"))).toBe(false);
  });

  it("la marge pioche aussi dans les volontaires du sondage \"Prête mon nom\" (ADR-017), prioritaires sur substituteBookers", () => {
    const availableSlots = makeSlots([1, 2], "10H30", "11H15");
    const groups = planJobBookings(
      rule({ unexpectedPlayersMargin: 1, substituteBookers: ["sebastien"] }),
      "2026-08-08",
      { "10H30": ["a", "b", "c"] },
      ["mustapha"], // volontaire du sondage — même sans substituteBookers configuré (règle vide en pratique).
      availableSlots,
      null,
    );
    const allIds = groups[0]!.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId]);
    expect(allIds).toContain("mustapha");
    expect(allIds).not.toContain("sebastien"); // le volontaire suffit pour la marge de 1, le défaut n'est pas consommé.
  });

  it("marge sans heure ayant de confirmés : aucun joueur de marge ajouté (rien à provisionner en plus de zéro)", () => {
    const availableSlots = makeSlots([1, 2], "10H30", "11H15");
    const groups = planJobBookings(
      rule({ unexpectedPlayersMargin: 2, substituteBookers: ["sebastien", "mustapha"] }),
      "2026-08-08",
      { "10H30": [] },
      [],
      availableSlots,
      null,
    );
    expect(groups[0]!.plan.proposedBookings).toEqual([]);
    expect(groups[0]!.plan.warnings.some((w) => w.includes("Pas assez de joueurs confirmés"))).toBe(true);
  });

  it("un joueur de marge consommé à une heure n'est jamais réutilisé à une autre heure le même jour", () => {
    const availableSlots = [...makeSlots([1, 2], "10H30", "11H15"), ...makeSlots([1, 2], "11H15", "12H00")];
    const groups = planJobBookings(
      rule({
        candidateStartTimes: ["10H30", "11H15"],
        unexpectedPlayersMargin: 1,
        substituteBookers: ["sebastien"],
      }),
      "2026-08-08",
      { "10H30": ["a", "b", "c"], "11H15": ["d", "e"] },
      [],
      availableSlots,
      null,
    );
    // Un seul prête-nom disponible : consommé par la 1ère heure ayant des confirmés (effectif impair
    // 3 → pair avec la marge), pas dispo pour la 2e (déjà pair, la marge n'y est donc pas nécessaire
    // mais le pool reste vide de toute façon).
    const ids1030 = groups[0]!.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId]);
    const ids1115 = groups[1]!.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId]);
    expect(ids1030).toContain("sebastien");
    expect(ids1115).not.toContain("sebastien");
  });
});

describe("planJobBookings — fusion cross-heures + rotation", () => {
  const vincent = "60bf2fdd1fd8d20020d2c8a7";
  const terence = "60bf46402d842c0027a508d4";
  const martin = "60e23b69a78d1100206b808c";

  function slotsForScenario(): AvailableSlot[] {
    const times = ["18H45", "19H30", "20H15", "21H00", "21H45"];
    const slots: AvailableSlot[] = [];
    let seq = 0;
    for (const beginTime of times) {
      const endParts = beginTime.match(/^(\d+)H(\d+)$/);
      if (!endParts) continue;
      const beginMin = Number(endParts[1]) * 60 + Number(endParts[2]);
      const endTime = `${String(Math.floor((beginMin + 45) / 60)).padStart(2, "0")}H${String((beginMin + 45) % 60).padStart(2, "0")}`.replace(
        /^0?(\d+)H/,
        (_, h) => `${h}H`,
      );
      for (let court = 1; court <= 4; court += 1) {
        seq += 1;
        slots.push({ sessionId: `s-${seq}`, court, beginTime, endTime: endTime === "19H60" ? "20H15" : endTime });
      }
    }
    return slots;
  }

  it("2 joueurs @ 18H45 + 1 @ 19H30 : Martin fusionné, court prolongé", () => {
    const groups = planJobBookings(
      rule({
        id: "squashacademie-mardi",
        resaSquashGroupId: "group-1",
        candidateStartTimes: ["18H45", "19H30"],
        maxReservationsPerPlayer: 2,
        courtPriority: [4, 3, 2, 1],
      }),
      "2026-08-11",
      { "18H45": [vincent, terence], "19H30": [martin] },
      [],
      slotsForScenario(),
      null,
    );

    expect(groups[0]!.plan.proposedBookings.length).toBeGreaterThanOrEqual(3);
    expect(groups[0]!.plan.proposedBookings.every((b) => b.court === 4)).toBe(true);
    expect(groups[1]!.plan.proposedBookings).toEqual([]);
    expect(groups[1]!.plan.warnings.some((w) => w.includes("fusionné"))).toBe(true);
    expect(groups[0]!.plan.meta.rotatingPlayerIds).toContain(martin);
  });
});
