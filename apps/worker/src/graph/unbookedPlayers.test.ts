import { describe, expect, it } from "vitest";
import type { BookingPlanGroup } from "./state.js";
import { countUnbookedConfirmedPlayersByTime } from "./unbookedPlayers.js";

function planGroup(
  startTime: string,
  sessionIds: string[],
  courtGroups: Array<{ members: string[]; sessionIds: string[] }> | undefined,
  outOfWindowSessionIds: string[] = [],
): BookingPlanGroup {
  return {
    startTime,
    outOfWindowSessionIds,
    plan: {
      dryRun: true,
      warnings: [],
      proposedBookings: sessionIds.map((sessionId) => ({
        sessionId,
        userId: "x",
        partnerId: "y",
        startDate: "2026-07-21T18:45:00+02:00",
        court: 1,
        slotTime: startTime,
        slotEndTime: startTime,
        groupId: "g",
      })),
      meta: {
        courtsNeeded: 1,
        roundsPlanned: sessionIds.length,
        dryRun: true,
        groupLabel: "g",
        recurringWeekday: 2,
        recurringStartTime: startTime,
        slotsPerPlayer: 2,
        groupMinSlotsPerPlayer: 2,
        groupMaxSlotsPerPlayer: 2,
        pairCount: 1,
        rotatingPlayerIds: [],
        courtGroups,
      },
    },
  };
}

describe("countUnbookedConfirmedPlayersByTime", () => {
  it("compte par heure votée les confirmés sans aucun créneau réservé", () => {
    const groups = [
      planGroup("18H45", ["s1", "s2"], [
        { members: ["a", "b"], sessionIds: ["s1"] },
        { members: ["c", "d"], sessionIds: ["s2"] },
      ], ["s2"]),
      planGroup("19H30", [], [{ members: ["e", "f"], sessionIds: [] }]),
    ];
    expect(
      countUnbookedConfirmedPlayersByTime(groups, { "18H45": ["a", "b", "c", "d"], "19H30": ["e", "f"] }),
    ).toEqual({ "18H45": 2, "19H30": 2 });
  });

  it("retardataire fusionné sur la session d'une heure antérieure : réservé, non compté à son heure", () => {
    const groups = [
      planGroup("18H45", ["s1"], [
        { members: ["a", "b"], sessionIds: ["s1"] },
        { members: ["late"], sessionIds: ["s1"] },
      ]),
      planGroup("19H30", [], []),
    ];
    expect(countUnbookedConfirmedPlayersByTime(groups, { "18H45": ["a", "b"], "19H30": ["late"] })).toEqual({
      "18H45": 0,
      "19H30": 0,
    });
  });

  it("refus de réservation réelle : le groupe refusé compte comme non réservé", () => {
    const groups = [planGroup("18H45", ["s1"], [{ members: ["a", "b"], sessionIds: ["s1"] }])];
    const failure = {
      sessionId: "s1",
      court: 1,
      slotTime: "18H45",
      slotEndTime: "19H30",
      userId: "a",
      partnerId: "b",
      reason: null,
      message: "m",
      rawError: "r",
    };
    expect(countUnbookedConfirmedPlayersByTime(groups, { "18H45": ["a", "b"] }, [failure])).toEqual({ "18H45": 2 });
  });

  it("ancien checkpoint sans courtGroups : aucun compte (alerte omise)", () => {
    const groups = [planGroup("18H45", [], undefined)];
    expect(countUnbookedConfirmedPlayersByTime(groups, { "18H45": ["a", "b"] })).toEqual({});
  });
});
