import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { BookingRule } from "@squash-assistant/db/schema";
import {
  __resetCronRegistryForTests,
  getScheduledRuleIds,
  reloadScheduler,
  startCronRegistry,
} from "./cronRegistry.js";

vi.mock("../bookingRules.js", () => ({
  loadBookingRules: vi.fn(),
  getBookingRuleById: vi.fn(),
}));

import { loadBookingRules } from "../bookingRules.js";

function rule(overrides: Partial<BookingRule> = {}): BookingRule {
  return {
    id: "r1",
    name: "R1",
    enabled: true,
    whatsappGroupJid: "g@test",
    resaSquashGroupId: "resa",
    pollCron: "0 0 1 1 *",
    decisionCron: "0 0 1 1 *",
    targetWeekdayOffset: 7,
    candidateStartTimes: ["18H45"],
    maxCourtsPerSlot: 1,
    minPlayersPerCourt: 2,
    maxPlayersPerCourt: 2,
    maxReservationsPerPlayer: 1,
    priorityBookers: [],
    preferMinPlayersPerCourt: true,
    courtPriority: [1],
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

describe("cronRegistry reload à chaud", () => {
  beforeEach(() => {
    __resetCronRegistryForTests();
    vi.mocked(loadBookingRules).mockReset();
  });

  afterEach(() => {
    __resetCronRegistryForTests();
  });

  it("planifie les règles enabled au start, et retire au reload si disabled", async () => {
    const onPoll = vi.fn(async () => {});
    const onDecision = vi.fn(async () => {});
    const db = {} as never;

    startCronRegistry([rule({ enabled: true })], {
      graph: {} as never,
      telegram: { botToken: "t", chatId: "c" },
      db,
      onPoll,
      onDecision,
    });
    expect(getScheduledRuleIds()).toEqual(["r1"]);

    vi.mocked(loadBookingRules).mockResolvedValue([rule({ enabled: false })]);
    const result = await reloadScheduler();
    expect(result.enabledRuleIds).toEqual([]);
    expect(getScheduledRuleIds()).toEqual([]);
  });

  it("reload replanifie une règle nouvellement enabled", async () => {
    startCronRegistry([], {
      graph: {} as never,
      telegram: { botToken: "t", chatId: "c" },
      db: {} as never,
      onPoll: async () => {},
      onDecision: async () => {},
    });
    expect(getScheduledRuleIds()).toEqual([]);

    vi.mocked(loadBookingRules).mockResolvedValue([rule({ id: "r2", enabled: true })]);
    const result = await reloadScheduler();
    expect(result.enabledRuleIds).toEqual(["r2"]);
    expect(getScheduledRuleIds()).toEqual(["r2"]);
  });
});
