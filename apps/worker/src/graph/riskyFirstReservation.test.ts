import { describe, expect, it, vi } from "vitest";
import { reserveRiskyFirst, type RiskyFirstDeps } from "./riskyFirstReservation.js";
import type { BookingPlanGroup } from "./state.js";
import type { BookedLine, LinesOutcome } from "./nodes/announce.js";

type Booking = BookingPlanGroup["plan"]["proposedBookings"][number];

function line(sessionId: string, userId: string, partnerId: string, slotTime = "19H30"): Booking {
  return { sessionId, userId, partnerId, court: 3, slotTime, slotEndTime: "20H15", startDate: "2026-11-10T19:30:00+01:00" };
}

function group(startTime: string, bookings: Booking[]): BookingPlanGroup {
  return {
    startTime,
    outOfWindowSessionIds: [],
    plan: {
      dryRun: true,
      proposedBookings: bookings,
      warnings: [],
      meta: {
        courtsNeeded: 1, roundsPlanned: bookings.length, dryRun: true, groupLabel: "r", recurringWeekday: 2,
        recurringStartTime: startTime, slotsPerPlayer: 1, groupMinSlotsPerPlayer: 0, groupMaxSlotsPerPlayer: 0,
        pairCount: bookings.length, courtGroups: [],
      },
    },
  };
}

function outcome(booked: Booking[], failed: Booking[] = [], exhaustedIds: string[] = []): LinesOutcome {
  return {
    substitutions: [],
    booked: booked.map((b): BookedLine => ({ sessionId: b.sessionId, userId: b.userId, partnerId: b.partnerId! })),
    failures: failed.map((b) => ({
      sessionId: b.sessionId, court: b.court, slotTime: b.slotTime, slotEndTime: b.slotEndTime,
      userId: b.userId, partnerId: b.partnerId ?? null, reason: "PLAYER_BOOKING_LIMIT_REACHED", message: "plus de crédits", rawError: "",
    })),
    exhaustedIds,
    firstError: failed.length > 0 ? new Error("refus") : undefined,
  };
}

const C4_1845 = line("c4-1845", "vinz", "mouss", "18H45");
const C4_1930 = line("c4-1930", "vinz", "ter");
const C4_2015 = line("c4-2015", "mouss", "ter", "20H15");
const C3_1930_JOKER = line("c3-1930", "tin", "joshua");
const C3_2015_JOKER = line("c3-2015", "tin", "joshua", "20H15");
const WITH_JOKER = [group("18H45", [C4_1845, C4_1930, C4_2015]), group("19H30", [C3_1930_JOKER, C3_2015_JOKER])];
const C3_1930 = line("c3-1930", "tin", "mouss");
const C4_2015_TIN = line("c4-2015", "tin", "ter", "20H15");
const WITHOUT_JOKER = [group("18H45", [C4_1845, C4_1930, C4_2015_TIN]), group("19H30", [C3_1930])];

describe("reserveRiskyFirst (ADR-039 point 6)", () => {
  it("réserve les lignes du joker avant toutes les autres", async () => {
    const order: string[] = [];
    const deps: RiskyFirstDeps = {
      reserveLines: vi.fn(async (lines: Booking[]) => {
        order.push(...lines.map((b) => b.sessionId));
        return outcome(lines);
      }),
      cancel: vi.fn(),
      replan: vi.fn(),
    };

    const result = await reserveRiskyFirst(deps, { groups: WITH_JOKER, riskyNameIds: new Set(["joshua"]) });

    expect(order).toEqual(["c3-1930", "c3-2015", "c4-1845", "c4-1930", "c4-2015"]);
    expect(deps.replan).not.toHaveBeenCalled();
    expect(result.groups).toBe(WITH_JOKER);
    expect(result.failures).toEqual([]);
  });

  it("joker refusé : ses lignes prises sont annulées, le plan est recalculé sans lui, puis réservé", async () => {
    const reserveLines = vi
      .fn<RiskyFirstDeps["reserveLines"]>()
      // 1er passage (lignes du joker) : la 1re passe, la 2e est refusée.
      .mockResolvedValueOnce(outcome([C3_1930_JOKER], [C3_2015_JOKER], ["joshua"]))
      // Plan recalculé : plus aucune ligne à risque, tout est réservé.
      .mockImplementation(async (lines: Booking[]) => outcome(lines));
    const deps: RiskyFirstDeps = {
      reserveLines,
      cancel: vi.fn(async () => {}),
      replan: vi.fn(async () => WITHOUT_JOKER),
    };

    const result = await reserveRiskyFirst(deps, { groups: WITH_JOKER, riskyNameIds: new Set(["joshua"]) });

    expect(deps.cancel).toHaveBeenCalledWith({ sessionId: "c3-1930", userId: "tin", partnerId: "joshua" });
    expect(deps.replan).toHaveBeenCalledWith(new Set(["joshua"]), expect.any(Array));
    expect(result.groups).toBe(WITHOUT_JOKER);
    expect(result.failures).toEqual([]);
    expect(result.booked.map((b) => b.sessionId).sort()).toEqual(["c3-1930", "c4-1845", "c4-1930", "c4-2015"]);
  });

  it("refus sans fautif identifié : les noms à risque de la ligne refusée sont exclus", async () => {
    const reserveLines = vi
      .fn<RiskyFirstDeps["reserveLines"]>()
      .mockResolvedValueOnce(outcome([], [C3_1930_JOKER, C3_2015_JOKER]))
      .mockImplementation(async (lines: Booking[]) => outcome(lines));
    const deps: RiskyFirstDeps = { reserveLines, cancel: vi.fn(async () => {}), replan: vi.fn(async () => WITHOUT_JOKER) };

    await reserveRiskyFirst(deps, { groups: WITH_JOKER, riskyNameIds: new Set(["joshua"]) });

    expect(deps.replan).toHaveBeenCalledWith(new Set(["joshua"]), expect.any(Array));
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it("le recalcul échoue encore : on n'insiste pas au-delà, les refus restants sont signalés", async () => {
    const reserveLines = vi
      .fn<RiskyFirstDeps["reserveLines"]>()
      .mockResolvedValueOnce(outcome([], [C3_1930_JOKER], ["joshua"]))
      // Le recalcul repropose la même ligne (rien de mieux possible) : nouveau refus.
      .mockResolvedValueOnce(outcome([], [C3_1930_JOKER], ["joshua"]))
      .mockImplementation(async (lines: Booking[]) => outcome(lines));
    const sameAgain = [group("18H45", [C4_1845]), group("19H30", [C3_1930_JOKER])];
    const deps: RiskyFirstDeps = { reserveLines, cancel: vi.fn(async () => {}), replan: vi.fn(async () => sameAgain) };

    const result = await reserveRiskyFirst(deps, { groups: WITH_JOKER, riskyNameIds: new Set(["joshua"]) });

    expect(deps.replan).toHaveBeenCalledTimes(1);
    expect(result.failures.map((f) => f.sessionId)).toEqual(["c3-1930"]);
    expect(result.booked.map((b) => b.sessionId)).toEqual(["c4-1845"]);
  });

  it("aucune ligne à risque : réservation directe, sans recalcul", async () => {
    const deps: RiskyFirstDeps = {
      reserveLines: vi.fn(async (lines: Booking[]) => outcome(lines)),
      cancel: vi.fn(),
      replan: vi.fn(),
    };

    const result = await reserveRiskyFirst(deps, { groups: WITHOUT_JOKER, riskyNameIds: new Set(["joshua"]) });

    expect(deps.reserveLines).toHaveBeenCalledTimes(1);
    expect(result.booked).toHaveLength(4);
  });

  it("une annulation qui échoue garde la ligne prise, sans message d'échec total", async () => {
    const reserveLines = vi
      .fn<RiskyFirstDeps["reserveLines"]>()
      .mockResolvedValueOnce(outcome([C3_1930_JOKER], [C3_2015_JOKER], ["joshua"]))
      .mockImplementation(async (lines: Booking[]) => outcome(lines));
    const deps: RiskyFirstDeps = {
      reserveLines,
      cancel: vi.fn(async () => {
        throw new Error("cancel_reservation indisponible");
      }),
      replan: vi.fn(async () => WITHOUT_JOKER),
    };

    const result = await reserveRiskyFirst(deps, { groups: WITH_JOKER, riskyNameIds: new Set(["joshua"]) });

    // Le court 3 de 19H30 reste au nom de Tin + joker : il remplace la ligne du nouveau plan.
    const c3 = result.groups.flatMap((g) => g.plan.proposedBookings).filter((b) => b.sessionId === "c3-1930");
    expect(c3).toEqual([expect.objectContaining({ userId: "tin", partnerId: "joshua" })]);
    expect(result.booked.map((b) => b.sessionId).sort()).toEqual(["c3-1930", "c4-1845", "c4-1930", "c4-2015"]);
    expect(result.failures).toEqual([]);
  });

  it("recalcul impossible : le plan d'origine est gardé, sans annulation", async () => {
    const reserveLines = vi
      .fn<RiskyFirstDeps["reserveLines"]>()
      .mockResolvedValueOnce(outcome([C3_1930_JOKER], [C3_2015_JOKER], ["joshua"]))
      .mockImplementation(async (lines: Booking[]) => outcome(lines));
    const deps: RiskyFirstDeps = {
      reserveLines,
      cancel: vi.fn(async () => {}),
      replan: vi.fn(async () => {
        throw new Error("list_availability en erreur");
      }),
    };

    const result = await reserveRiskyFirst(deps, { groups: WITH_JOKER, riskyNameIds: new Set(["joshua"]) });

    expect(deps.cancel).not.toHaveBeenCalled();
    expect(result.groups).toBe(WITH_JOKER);
    expect(result.failures.map((f) => f.sessionId)).toEqual(["c3-2015"]);
    expect(result.booked.map((b) => b.sessionId).sort()).toEqual(["c3-1930", "c4-1845", "c4-1930", "c4-2015"]);
  });

  it("refus sans rapport avec un joueur (court déjà pris) : pas de recalcul", async () => {
    const taken = outcome([], [C3_1930_JOKER]);
    taken.failures[0] = { ...taken.failures[0]!, reason: "SLOT_ALREADY_BOOKED" };
    const reserveLines = vi
      .fn<RiskyFirstDeps["reserveLines"]>()
      .mockResolvedValueOnce(taken)
      .mockImplementation(async (lines: Booking[]) => outcome(lines));
    const deps: RiskyFirstDeps = { reserveLines, cancel: vi.fn(), replan: vi.fn() };

    const result = await reserveRiskyFirst(deps, { groups: WITH_JOKER, riskyNameIds: new Set(["joshua"]) });

    expect(deps.replan).not.toHaveBeenCalled();
    expect(result.failures.map((f) => f.sessionId)).toEqual(["c3-1930"]);
  });

  it("ligne prise identique dans le nouveau plan : ni annulée ni re-réservée", async () => {
    const reserveLines = vi
      .fn<RiskyFirstDeps["reserveLines"]>()
      .mockResolvedValueOnce(outcome([C3_1930_JOKER], [C3_2015_JOKER], ["joshua"]))
      .mockImplementation(async (lines: Booking[]) => outcome(lines));
    const keeps = [group("18H45", [C4_1845, C4_1930, C4_2015_TIN]), group("19H30", [C3_1930_JOKER])];
    const deps: RiskyFirstDeps = { reserveLines, cancel: vi.fn(async () => {}), replan: vi.fn(async () => keeps) };

    const result = await reserveRiskyFirst(deps, { groups: WITH_JOKER, riskyNameIds: new Set(["joshua"]) });

    expect(deps.cancel).not.toHaveBeenCalled();
    const reservedAfter = reserveLines.mock.calls.slice(1).flatMap(([lines]) => lines.map((b) => b.sessionId));
    expect(reservedAfter).not.toContain("c3-1930");
    expect(result.booked).toHaveLength(4);
  });

  it("court gardé faute d'annulation et absent du nouveau plan : réinjecté à son heure avec ses joueurs", async () => {
    const tinCourt = group("19H30", [C3_1930_JOKER, C3_2015_JOKER]);
    tinCourt.plan.meta.courtGroups = [{ members: ["tin"], sessionIds: ["c3-1930", "c3-2015"] }];
    const reserveLines = vi
      .fn<RiskyFirstDeps["reserveLines"]>()
      .mockResolvedValueOnce(outcome([C3_1930_JOKER], [C3_2015_JOKER], ["joshua"]))
      .mockImplementation(async (lines: Booking[]) => outcome(lines));
    const deps: RiskyFirstDeps = {
      reserveLines,
      cancel: vi.fn(async () => {
        throw new Error("cancel_reservation indisponible");
      }),
      replan: vi.fn(async () => [group("18H45", [C4_1845]), group("19H30", [])]),
    };

    const result = await reserveRiskyFirst(deps, { groups: [group("18H45", [C4_1845]), tinCourt], riskyNameIds: new Set(["joshua"]) });

    const at1930 = result.groups.find((g) => g.startTime === "19H30")!;
    expect(at1930.plan.proposedBookings.map((b) => b.sessionId)).toEqual(["c3-1930"]);
    expect(at1930.plan.meta.courtGroups).toEqual([{ members: ["tin"], sessionIds: ["c3-1930"] }]);
  });

  it("ligne prise par substitution, prévue à l'identique par le recalcul : gardée", async () => {
    const first = outcome([C3_1930_JOKER], [C3_2015_JOKER], ["joshua"]);
    first.booked = [{ sessionId: "c3-1930", userId: "tin", partnerId: "seb" }];
    const reserveLines = vi
      .fn<RiskyFirstDeps["reserveLines"]>()
      .mockResolvedValueOnce(first)
      .mockImplementation(async (lines: Booking[]) => outcome(lines));
    const keeps = [group("18H45", [C4_1845]), group("19H30", [C3_1930_JOKER])];
    const deps: RiskyFirstDeps = { reserveLines, cancel: vi.fn(async () => {}), replan: vi.fn(async () => keeps) };

    await reserveRiskyFirst(deps, { groups: WITH_JOKER, riskyNameIds: new Set(["joshua", "seb"]) });

    expect(deps.cancel).not.toHaveBeenCalled();
  });
});

