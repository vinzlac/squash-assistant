import { describe, expect, it } from "vitest";
import { scheduleGroupTimeline } from "./scheduleGroupTimeline.js";
import type { AvailableSlot } from "./courtAssignment.js";
import type { Group } from "./groups.js";

function makeSlots(courts: number[], beginTime: string, endTime: string): AvailableSlot[] {
  return courts.map((court) => ({ sessionId: `s-${court}-${beginTime}`, court, beginTime, endTime }));
}

function byTimeFrom(slots: AvailableSlot[]): Map<string, AvailableSlot[]> {
  const m = new Map<string, AvailableSlot[]>();
  for (const s of slots) {
    const arr = m.get(s.beginTime) ?? [];
    arr.push(s);
    m.set(s.beginTime, arr);
  }
  return m;
}

describe("scheduleGroupTimeline", () => {
  it("groupe de 2 : réserve roundsNeeded créneaux consécutifs sur le même court", () => {
    const slots = [...makeSlots([3, 4], "10H30", "11H15"), ...makeSlots([3, 4], "11H15", "12H00")];
    const byTime = byTimeFrom(slots);
    const warnings: string[] = [];
    const group: Group = { members: ["a", "b"], roundsNeeded: 2 };

    const bookings = scheduleGroupTimeline({
      group,
      startTime: "10H30",
      onDate: "2026-08-04",
      groupId: "g1",
      byTime,
      sortedTimes: ["10H30", "11H15"],
      claimedThisCall: new Set(),
      courtPriority: [4, 3, 2, 1],
      substituteQueue: [],
      existingDailyCounts: {},
      maxDailyReservationsPerPlayer: 2,
      warnings,
    });

    expect(bookings).toHaveLength(2);
    expect(bookings.every((b) => b.court === bookings[0]!.court)).toBe(true);
    expect(bookings.map((b) => b.slotTime)).toEqual(["10H30", "11H15"]);
    expect(bookings.every((b) => b.userId === "a" && b.partnerId === "b")).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("groupe de 3 : nomme les joueurs par round-robin (teamrNamesForRound), même court sur les 3 rounds", () => {
    const slots = [
      ...makeSlots([1], "10H30", "11H15"),
      ...makeSlots([1], "11H15", "12H00"),
      ...makeSlots([1], "12H00", "12H45"),
    ];
    const byTime = byTimeFrom(slots);
    const group: Group = { members: ["a", "b", "c"], roundsNeeded: 3 };

    const bookings = scheduleGroupTimeline({
      group,
      startTime: "10H30",
      onDate: "2026-08-04",
      groupId: "g1",
      byTime,
      sortedTimes: ["10H30", "11H15", "12H00"],
      claimedThisCall: new Set(),
      courtPriority: [1, 2, 3, 4],
      substituteQueue: [],
      existingDailyCounts: {},
      maxDailyReservationsPerPlayer: 2,
      warnings: [],
    });

    expect(bookings.map((b) => [b.userId, b.partnerId])).toEqual([
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
    expect(bookings.every((b) => b.court === 1)).toBe(true);
  });

  it("respecte le plafond quotidien : remplace le joueur au plafond par un prête-nom", () => {
    const slots = makeSlots([1], "10H30", "11H15");
    const byTime = byTimeFrom(slots);
    const warnings: string[] = [];
    const group: Group = { members: ["a", "b"], roundsNeeded: 1 };

    const bookings = scheduleGroupTimeline({
      group,
      startTime: "10H30",
      onDate: "2026-08-04",
      groupId: "g1",
      byTime,
      sortedTimes: ["10H30"],
      claimedThisCall: new Set(),
      courtPriority: [1, 2, 3, 4],
      substituteQueue: ["sub-1"],
      existingDailyCounts: { a: 2 },
      maxDailyReservationsPerPlayer: 2,
      warnings,
    });

    expect(bookings).toEqual([expect.objectContaining({ userId: "sub-1", partnerId: "b" })]);
    expect(warnings.some((w) => w.includes("remplacé par le prête-nom sub-1"))).toBe(true);
  });

  it("le titulaire de la clé API est plafonné et substitué comme n'importe quel joueur (bugfix 2026-08-27 : son compte a un vrai quota TeamR, il n'est plus exempté)", () => {
    const slots = makeSlots([1], "10H30", "11H15");
    const byTime = byTimeFrom(slots);
    const warnings: string[] = [];
    const group: Group = { members: ["vincent", "b"], roundsNeeded: 1 };

    const bookings = scheduleGroupTimeline({
      group,
      startTime: "10H30",
      onDate: "2026-08-04",
      groupId: "g1",
      byTime,
      sortedTimes: ["10H30"],
      claimedThisCall: new Set(),
      courtPriority: [1, 2, 3, 4],
      substituteQueue: ["sub-1"],
      existingDailyCounts: { vincent: 2 },
      maxDailyReservationsPerPlayer: 2,
      warnings,
    });

    expect(bookings).toEqual([expect.objectContaining({ userId: "sub-1", partnerId: "b" })]);
    expect(warnings.some((w) => w.includes("vincent") && w.includes("remplacé par le prête-nom sub-1"))).toBe(true);
  });

  it("warning explicite si les créneaux disponibles ne suffisent pas à atteindre roundsNeeded", () => {
    const slots = makeSlots([1], "10H30", "11H15");
    const byTime = byTimeFrom(slots);
    const warnings: string[] = [];
    const group: Group = { members: ["a", "b"], roundsNeeded: 2 };

    const bookings = scheduleGroupTimeline({
      group,
      startTime: "10H30",
      onDate: "2026-08-04",
      groupId: "g1",
      byTime,
      sortedTimes: ["10H30"],
      claimedThisCall: new Set(),
      courtPriority: [1, 2, 3, 4],
      substituteQueue: [],
      existingDailyCounts: {},
      maxDailyReservationsPerPlayer: 2,
      warnings,
    });

    expect(bookings).toHaveLength(1);
    expect(warnings.some((w) => w.includes("1/2 round(s) réservé(s)"))).toBe(true);
  });

  it("respecte la continuité de court sur les rounds successifs même si un autre court est mieux classé", () => {
    const slots = [...makeSlots([3, 4], "10H30", "11H15"), ...makeSlots([3, 4], "11H15", "12H00")];
    const byTime = byTimeFrom(slots);
    const claimedThisCall = new Set<string>();
    // Le groupe A prend le court 4 (mieux classé) en premier.
    const groupA: Group = { members: ["a", "b"], roundsNeeded: 1 };
    scheduleGroupTimeline({
      group: groupA,
      startTime: "10H30",
      onDate: "2026-08-04",
      groupId: "g1",
      byTime,
      sortedTimes: ["10H30", "11H15"],
      claimedThisCall,
      courtPriority: [4, 3, 2, 1],
      substituteQueue: [],
      existingDailyCounts: {},
      maxDailyReservationsPerPlayer: 2,
      warnings: [],
    });
    // Le groupe B (2 rounds) doit rester sur le même court sur ses 2 rounds, pas sauter entre 3 et 4.
    const groupB: Group = { members: ["c", "d"], roundsNeeded: 2 };
    const bookingsB = scheduleGroupTimeline({
      group: groupB,
      startTime: "10H30",
      onDate: "2026-08-04",
      groupId: "g1",
      byTime,
      sortedTimes: ["10H30", "11H15"],
      claimedThisCall,
      courtPriority: [4, 3, 2, 1],
      substituteQueue: [],
      existingDailyCounts: {},
      maxDailyReservationsPerPlayer: 2,
      warnings: [],
    });
    expect(bookingsB.every((b) => b.court === bookingsB[0]!.court)).toBe(true);
  });
});
