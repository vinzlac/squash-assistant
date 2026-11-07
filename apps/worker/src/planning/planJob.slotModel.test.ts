import { describe, expect, it } from "vitest";
import { planJobBookings } from "./planJob.js";
import type { AvailableSlot } from "./courtAssignment.js";
import type { BookingRule } from "../config.js";
import type { BookingPlanGroup } from "../graph/state.js";
import { countUnbookedConfirmedPlayers } from "../graph/unbookedPlayers.js";

// ADR-039 : plan créneau par créneau, scénario réel du mardi 2026-11-10 (job 3c01d13f).
const VINZ = "vinz";
const MOUSS = "mouss";
const TER = "ter";
const TIN = "tin";
const SEB = "seb";
const JOKER = "joshua";

const VOTES = { "18H45": [VINZ, MOUSS, TER], "19H30": [TIN] };
const PREFS = {
  defaults: { defaultMinPlaySlots: 2, defaultMaxPlaySlots: 2 },
  overrides: new Map([
    [VINZ, { minSlots: 2, maxSlots: 3 }],
    [MOUSS, { minSlots: 2, maxSlots: 3 }],
  ]),
};

const TIMES: Array<[string, string]> = [
  ["18H45", "19H30"],
  ["19H30", "20H15"],
  ["20H15", "21H00"],
  ["21H00", "21H45"],
  ["21H45", "22H30"],
];

function allCourtsFree(): AvailableSlot[] {
  return [4, 3, 2, 1].flatMap((court) =>
    TIMES.map(([beginTime, endTime]) => ({ sessionId: `s-${court}-${beginTime}`, court, beginTime, endTime })),
  );
}

function rule(overrides: Partial<BookingRule> = {}): BookingRule {
  return {
    id: "squashacademie-mardi-v2",
    name: null,
    enabled: true,
    whatsappGroupJid: "group@test",
    resaSquashGroupId: "group-1",
    targetWeekday: 2,
    pollDaysBefore: 7,
    pollTime: "10:00",
    decisionDaysBefore: 5,
    decisionTime: "09:00",
    confirmationDaysBefore: 5,
    confirmationTime: "10:30",
    candidateStartTimes: ["18H45", "19H30"],
    maxCourtsPerSlot: 3,
    minPlayersPerCourt: 2,
    maxPlayersPerCourt: 3,
    maxReservationsPerPlayer: 2,
    priorityBookers: [VINZ],
    preferMinPlayersPerCourt: true,
    courtPriority: [4, 3, 2, 1],
    availabilityWindowHours: 3,
    description: null,
    substituteBookers: [],
    maxDailyReservationsPerPlayer: 2,
    unexpectedPlayersMargin: 0,
    reservationNotifyWhatsappGroupJid: null,
    confirmationNotifyWhatsappGroupJid: null,
    cronJitterWindowMinutes: 60,
    requireTelegramGoForAutoJobs: false,
    nextDayReminderEnabled: false,
    pinMessagesEnabled: false,
    startReminderEnabled: false,
    startReminderMinutesBefore: 60,
    jokerBookerId: null,
    ...overrides,
  };
}

function lines(groups: BookingPlanGroup[]) {
  return groups.flatMap((g) => g.plan.proposedBookings);
}

function courtSlots(groups: BookingPlanGroup[]): string[] {
  return lines(groups)
    .map((b) => `C${b.court} ${b.slotTime}`)
    .sort();
}

function namesCount(groups: BookingPlanGroup[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of lines(groups)) {
    for (const id of [b.userId, b.partnerId]) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Invariants TeamR : 2 noms distincts par ligne, un nom au plus une fois par créneau, plafond respecté. */
function expectValidNames(groups: BookingPlanGroup[], cap: number, uncapped: string[] = []) {
  const bySlot = new Map<string, string[]>();
  for (const b of lines(groups)) {
    expect(b.partnerId).toBeTruthy();
    expect(b.userId).not.toBe(b.partnerId);
    bySlot.set(b.slotTime, [...(bySlot.get(b.slotTime) ?? []), b.userId, b.partnerId!]);
  }
  for (const names of bySlot.values()) expect(new Set(names).size).toBe(names.length);
  for (const [id, n] of namesCount(groups)) if (!uncapped.includes(id)) expect(n).toBeLessThanOrEqual(cap);
}

describe("planJobBookings — plan créneau par créneau (ADR-039)", () => {
  it("avec un prête-nom volontaire : court 4 de 18H45 à 21H00 et court 3 de 19H30 à 21H00", () => {
    const groups = planJobBookings(rule({ jokerBookerId: JOKER }), "2026-11-10", VOTES, [SEB], allCourtsFree(), null, PREFS);

    expect(courtSlots(groups)).toEqual(["C3 19H30", "C3 20H15", "C4 18H45", "C4 19H30", "C4 20H15"]);
    expectValidNames(groups, 2);
    expect(namesCount(groups).get(SEB)).toBe(2);
    expect(namesCount(groups).has(JOKER)).toBe(false);
    // Le court 3 est ouvert pour Tin : il appartient à l'heure 19H30 (roster : Tin a un court).
    const at1930 = groups.find((g) => g.startTime === "19H30")!;
    expect(at1930.plan.proposedBookings.map((b) => b.court)).toEqual([3, 3]);
    expect(countUnbookedConfirmedPlayers(groups, VOTES)).toBe(0);
  });

  it("sans prête-nom ni joker : 4 lignes, le manque retombe sur 20H15, Tin joue", () => {
    const groups = planJobBookings(rule(), "2026-11-10", VOTES, [], allCourtsFree(), null, PREFS);

    expect(courtSlots(groups)).toEqual(["C3 19H30", "C4 18H45", "C4 19H30", "C4 20H15"]);
    expectValidNames(groups, 2);
    for (const id of [VINZ, MOUSS, TER, TIN]) expect(namesCount(groups).get(id)).toBe(2);
    expect(countUnbookedConfirmedPlayers(groups, VOTES)).toBe(0);
  });

  it("joker refusé (exclu au recalcul) : même plan que sans prête-nom ni joker", () => {
    const withJoker = planJobBookings(rule({ jokerBookerId: JOKER }), "2026-11-10", VOTES, [], allCourtsFree(), null, PREFS);
    expect(namesCount(withJoker).get(JOKER)).toBe(2);
    expect(courtSlots(withJoker)).toEqual(["C3 19H30", "C3 20H15", "C4 18H45", "C4 19H30", "C4 20H15"]);

    const replanned = planJobBookings(rule({ jokerBookerId: JOKER }), "2026-11-10", VOTES, [], allCourtsFree(), null, {
      ...PREFS,
      excludedBookerIds: new Set([JOKER]),
    });
    expect(courtSlots(replanned)).toEqual(["C3 19H30", "C4 18H45", "C4 19H30", "C4 20H15"]);
    expect(namesCount(replanned).has(JOKER)).toBe(false);
    expect(countUnbookedConfirmedPlayers(replanned, VOTES)).toBe(0);
  });

  it("le joker n'est jamais titulaire d'une ligne", () => {
    const groups = planJobBookings(rule({ jokerBookerId: JOKER }), "2026-11-10", VOTES, [], allCourtsFree(), null, PREFS);
    expect(lines(groups).some((b) => b.userId === JOKER)).toBe(false);
  });

  it("aucun créneau ajouté une fois tous les minima atteints", () => {
    const groups = planJobBookings(rule(), "2026-11-10", { "18H45": [VINZ, MOUSS] }, [SEB], allCourtsFree(), null, PREFS);
    expect(courtSlots(groups)).toEqual(["C4 18H45", "C4 19H30"]);
  });

  it("un joueur n'est jamais placé avant son heure votée", () => {
    const groups = planJobBookings(rule(), "2026-11-10", { "18H45": [VINZ, MOUSS], "19H30": [TER, TIN] }, [], allCourtsFree(), null, PREFS);
    for (const b of lines(groups)) {
      if (b.slotTime === "18H45") expect([b.userId, b.partnerId].some((id) => id === TER || id === TIN)).toBe(false);
    }
    expect(courtSlots(groups)).toEqual(["C3 19H30", "C3 20H15", "C4 18H45", "C4 19H30"]);
  });

  it("fenêtre appliquée à chaque joueur : aucune ligne planifiée n'est hors fenêtre", () => {
    const oneCourt = allCourtsFree().filter((slot) => slot.court === 4);
    const groups = planJobBookings(
      rule({ availabilityWindowHours: 1 }),
      "2026-11-10",
      { "18H45": [VINZ, MOUSS], "19H30": [TIN] },
      [],
      oneCourt,
      null,
      PREFS,
    );
    expect(groups.every((g) => g.outOfWindowSessionIds.length === 0)).toBe(true);
    // Tin (19H30 + 1 h) ne joue pas au-delà de 20H15.
    for (const b of lines(groups)) if (b.userId === TIN || b.partnerId === TIN) expect(["19H30", "20H15"]).toContain(b.slotTime);
  });

  it("un créneau sans court libre est sauté, le suivant est utilisé", () => {
    const gap = allCourtsFree().filter((slot) => slot.court === 4 && slot.beginTime !== "19H30");
    const groups = planJobBookings(rule(), "2026-11-10", { "18H45": [VINZ, MOUSS] }, [], gap, null, PREFS);
    expect(courtSlots(groups)).toEqual(["C4 18H45", "C4 20H15"]);
  });

  it("un joker qui vote comme joueur est plafonné comme les autres", () => {
    const groups = planJobBookings(rule({ jokerBookerId: JOKER }), "2026-11-10", { "18H45": [VINZ, JOKER] }, [], allCourtsFree(), null, PREFS);
    expect(courtSlots(groups)).toEqual(["C4 18H45", "C4 19H30"]);
    expectValidNames(groups, 2);
  });
});

