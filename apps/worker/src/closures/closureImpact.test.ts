import { describe, expect, it } from "vitest";
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import { computeClosureImpact, targetDatesInInterval } from "./closureImpact.js";

function rule(overrides: Partial<BookingRule> = {}): BookingRule {
  return {
    id: "rule-sam",
    name: "Samedi",
    enabled: true,
    whatsappGroupJid: "g@test",
    resaSquashGroupId: "resa-1",
    targetWeekday: 6,
    pollDaysBefore: 7,
    pollTime: "10:00",
    decisionDaysBefore: 4,
    decisionTime: "21:30",
    candidateStartTimes: ["18H45", "19H30"],
    maxCourtsPerSlot: 3,
    minPlayersPerCourt: 2,
    maxPlayersPerCourt: 3,
    maxReservationsPerPlayer: 2,
    priorityBookers: [],
    preferMinPlayersPerCourt: true,
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

function job(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: "job-1",
    bookingRuleId: "rule-sam",
    targetDate: "2026-09-19",
    candidateStartTimes: null,
    pollRequestId: "poll-1",
    pollMsgId: "msg-1",
    ruleSnapshot: null,
    cancelledAt: null,
    cancelReason: null,
    clubClosureId: null,
    auto: true,
    nextDayReminderSentAt: null,
    createdAt: new Date("2026-09-12T08:00:00Z"),
    ...overrides,
  };
}

// Samedi 19 septembre 2026, journée entière Paris (CEST = UTC+2)
const wholeDay = { startsAt: new Date("2026-09-18T22:00:00Z"), endsAt: new Date("2026-09-19T22:00:00Z"), label: "tournoi" };
// Samedi 19 septembre 2026, 18:00 → 19:00 Paris : couvre 18H45 mais pas 19H30
const partial = { startsAt: new Date("2026-09-19T16:00:00Z"), endsAt: new Date("2026-09-19T17:00:00Z"), label: "tournoi" };
const now = new Date("2026-09-12T10:00:00Z");

describe("computeClosureImpact", () => {
  it("journée entière : job en cours (awaiting-decision) → running avec toutes les heures fermées", () => {
    const impact = computeClosureImpact(wholeDay, [rule()], [{ job: job(), stage: "awaiting-decision" }], now);
    expect(impact.running).toEqual([
      { ruleId: "rule-sam", ruleLabel: "Samedi", jobId: "job-1", targetDate: "2026-09-19", stage: "awaiting-decision", closedTimes: ["18H45", "19H30"] },
    ]);
    expect(impact.planned).toEqual([]);
    expect(impact.errored).toEqual([]);
  });

  it("fermeture partielle couvrant une heure sur deux → running (une heure suffit)", () => {
    const impact = computeClosureImpact(partial, [rule()], [{ job: job(), stage: "awaiting-go" }], now);
    expect(impact.running).toHaveLength(1);
    expect(impact.running[0]!.closedTimes).toEqual(["18H45"]);
  });

  it("fermeture ne couvrant aucune heure candidate → rien", () => {
    const outside = { startsAt: new Date("2026-09-19T08:00:00Z"), endsAt: new Date("2026-09-19T10:00:00Z") };
    const impact = computeClosureImpact(outside, [rule()], [{ job: job(), stage: "awaiting-decision" }], now);
    expect(impact).toEqual({ running: [], planned: [], errored: [] });
  });

  it("les heures candidates du job priment sur celles de la règle", () => {
    const impact = computeClosureImpact(
      partial,
      [rule()],
      [{ job: job({ candidateStartTimes: ["19H30"] }), stage: "awaiting-decision" }],
      now,
    );
    expect(impact.running).toEqual([]);
  });

  it("job annulé ou terminé : ignoré", () => {
    const impact = computeClosureImpact(
      wholeDay,
      [rule()],
      [
        { job: job({ id: "j-cancelled", cancelledAt: new Date() }), stage: "awaiting-decision" },
        { job: job({ id: "j-done" }), stage: "finished-announced" },
        { job: job({ id: "j-closed" }), stage: "finished-club-closed" },
      ],
      now,
    );
    expect(impact).toEqual({ running: [], planned: [], errored: [] });
  });

  it("job en erreur → errored, sans action", () => {
    const impact = computeClosureImpact(wholeDay, [rule()], [{ job: job(), stage: "error" }], now);
    expect(impact.errored.map((e) => e.jobId)).toEqual(["job-1"]);
    expect(impact.running).toEqual([]);
  });

  it("job not-started existant → planned", () => {
    const impact = computeClosureImpact(
      wholeDay,
      [rule()],
      [{ job: job({ pollRequestId: null, pollMsgId: null }), stage: "not-started" }],
      now,
    );
    expect(impact.planned).toEqual([
      { ruleId: "rule-sam", ruleLabel: "Samedi", jobId: "job-1", targetDate: "2026-09-19", stage: "not-started", closedTimes: ["18H45", "19H30"] },
    ]);
  });

  it("règle active sans job pour la date cible couverte → planned avec jobId null", () => {
    const impact = computeClosureImpact(wholeDay, [rule()], [], now);
    expect(impact.planned).toEqual([
      { ruleId: "rule-sam", ruleLabel: "Samedi", jobId: null, targetDate: "2026-09-19", stage: "not-created", closedTimes: ["18H45", "19H30"] },
    ]);
  });

  it("règle désactivée : jamais listée sans job", () => {
    const impact = computeClosureImpact(wholeDay, [rule({ enabled: false })], [], now);
    expect(impact.planned).toEqual([]);
  });

  it("règle avec un job existant pour la date : pas de doublon « not-created »", () => {
    const impact = computeClosureImpact(wholeDay, [rule()], [{ job: job(), stage: "awaiting-decision" }], now);
    expect(impact.planned).toEqual([]);
  });

  it("ruleLabel retombe sur l'id si la règle n'a pas de nom", () => {
    const impact = computeClosureImpact(wholeDay, [rule({ name: null })], [], now);
    expect(impact.planned[0]!.ruleLabel).toBe("rule-sam");
  });
});

describe("targetDatesInInterval", () => {
  it("liste les samedis futurs couverts par l'intervalle (jour Paris)", () => {
    const twoWeeks = { startsAt: new Date("2026-09-18T22:00:00Z"), endsAt: new Date("2026-10-03T22:00:00Z") };
    expect(targetDatesInInterval(twoWeeks, 6, now)).toEqual(["2026-09-19", "2026-09-26", "2026-10-03"]);
  });

  it("exclut les dates passées", () => {
    expect(targetDatesInInterval(wholeDay, 6, new Date("2026-09-20T10:00:00Z"))).toEqual([]);
  });
});
