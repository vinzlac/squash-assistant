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

const scheduledCronCalls: Array<{ expr: string; cb: () => void }> = [];
vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((expr: string, cb: () => void) => {
      scheduledCronCalls.push({ expr, cb });
      return { stop: vi.fn() };
    }),
  },
}));

vi.mock("./cronJitter.js", () => ({
  scheduleWithCronJitter: vi.fn((_label: string, _windowMinutes: number, fn: () => Promise<void>) => {
    // Reflète le self-catch de la vraie implémentation (schedule(() => { void fn().catch(() => {}) }))
    void fn().catch(() => {});
  }),
}));

import { scheduleWithCronJitter } from "./cronJitter.js";
import { getBookingRuleById } from "../bookingRules.js";

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
    nextDayReminderEnabled: false,
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
      onReminder: async () => {},
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
      onReminder: async () => {},
    });
    expect(getScheduledRuleIds()).toEqual([]);

    vi.mocked(loadBookingRules).mockResolvedValue([rule({ id: "r2", enabled: true })]);
    const result = await reloadScheduler();
    expect(result.enabledRuleIds).toEqual(["r2"]);
    expect(getScheduledRuleIds()).toEqual(["r2"]);
  });
});

describe("jitter pollCron vs decisionCron", () => {
  beforeEach(() => {
    __resetCronRegistryForTests();
    scheduledCronCalls.length = 0;
    vi.mocked(scheduleWithCronJitter).mockClear();
    vi.mocked(getBookingRuleById).mockReset();
  });

  afterEach(() => {
    __resetCronRegistryForTests();
  });

  it("le tick pollCron passe par scheduleWithCronJitter, le tick decisionCron appelle onDecision directement", async () => {
    const onPoll = vi.fn(async () => {});
    const onDecision = vi.fn(async () => {});
    const testRule = rule({ pollCron: "0 10 * * 2", decisionCron: "30 21 * * 2" });
    vi.mocked(getBookingRuleById).mockResolvedValue(testRule);

    startCronRegistry([testRule], {
      graph: {} as never,
      telegram: { botToken: "t", chatId: "c" },
      db: {} as never,
      onPoll,
      onDecision,
      onReminder: async () => {},
    });

    const pollCall = scheduledCronCalls.find((c) => c.expr === "0 10 * * 2");
    const decisionCall = scheduledCronCalls.find((c) => c.expr === "30 21 * * 2");
    expect(pollCall).toBeDefined();
    expect(decisionCall).toBeDefined();

    // Les deux callbacks font chacun un `await import("../bookingRules.js")` dynamique ;
    // les déclencher en parallèle fait courir deux résolutions concurrentes du même
    // spécificateur mocké, ce qui est instable avec le mocking de dynamic import de
    // Vitest. On attend la résolution du premier tick avant de déclencher le second
    // pour fiabiliser le test (le comportement métier testé reste inchangé).
    pollCall!.cb();
    await vi.waitFor(() => {
      expect(onPoll).toHaveBeenCalledWith(testRule);
    });
    decisionCall!.cb();
    await vi.waitFor(() => {
      expect(onDecision).toHaveBeenCalledWith(testRule);
    });

    expect(scheduleWithCronJitter).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleWithCronJitter).mock.calls[0]![0]).toContain("pollCron");
  });

  it("enregistre un 3e cron « rappel J+1 » (05 0 * * *) et l'appelle seulement si nextDayReminderEnabled", async () => {
    const onPoll = vi.fn(async () => {});
    const onDecision = vi.fn(async () => {});
    const onReminder = vi.fn(async () => {});
    const enabledRule = rule({ nextDayReminderEnabled: true });
    vi.mocked(getBookingRuleById).mockResolvedValue(enabledRule);

    startCronRegistry([enabledRule], {
      graph: {} as never,
      telegram: { botToken: "t", chatId: "c" },
      db: {} as never,
      onPoll,
      onDecision,
      onReminder,
    });

    const reminderCall = scheduledCronCalls.find((c) => c.expr === "5 0 * * *");
    expect(reminderCall).toBeDefined();

    reminderCall!.cb();
    await vi.waitFor(() => {
      expect(onReminder).toHaveBeenCalledWith(enabledRule);
    });
    expect(
      vi.mocked(scheduleWithCronJitter).mock.calls.some((c) => c[0] === `${enabledRule.id} reminderCron`),
    ).toBe(true);
  });

  it("contient l'erreur si onDecision rejette, sans laisser la rejection se propager", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onDecision = vi.fn(async () => {
      throw new Error("boom decision");
    });
    const testRule = rule({ decisionCron: "30 21 * * 2" });
    vi.mocked(getBookingRuleById).mockResolvedValue(testRule);

    startCronRegistry([testRule], {
      graph: {} as never,
      telegram: { botToken: "t", chatId: "c" },
      db: {} as never,
      onPoll: async () => {},
      onDecision,
      onReminder: async () => {},
    });

    const decisionCall = scheduledCronCalls.find((c) => c.expr === "30 21 * * 2");
    expect(decisionCall).toBeDefined();

    expect(() => decisionCall!.cb()).not.toThrow();
    await vi.waitFor(() => {
      expect(onDecision).toHaveBeenCalledWith(testRule);
    });
    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    consoleErrorSpy.mockRestore();
  });

  it("contient l'erreur si onPoll rejette, sans laisser la rejection se propager", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onPoll = vi.fn(async () => {
      throw new Error("boom poll");
    });
    const testRule = rule({ pollCron: "0 10 * * 2" });
    vi.mocked(getBookingRuleById).mockResolvedValue(testRule);

    startCronRegistry([testRule], {
      graph: {} as never,
      telegram: { botToken: "t", chatId: "c" },
      db: {} as never,
      onPoll,
      onDecision: async () => {},
      onReminder: async () => {},
    });

    const pollCall = scheduledCronCalls.find((c) => c.expr === "0 10 * * 2");
    expect(pollCall).toBeDefined();

    expect(() => pollCall!.cb()).not.toThrow();
    await vi.waitFor(() => {
      expect(onPoll).toHaveBeenCalledWith(testRule);
    });

    consoleErrorSpy.mockRestore();
  });

  it("n'appelle pas onReminder si nextDayReminderEnabled est false", async () => {
    const onReminder = vi.fn(async () => {});
    const disabledRule = rule({ nextDayReminderEnabled: false });
    vi.mocked(getBookingRuleById).mockResolvedValue(disabledRule);

    startCronRegistry([disabledRule], {
      graph: {} as never,
      telegram: { botToken: "t", chatId: "c" },
      db: {} as never,
      onPoll: async () => {},
      onDecision: async () => {},
      onReminder,
    });

    const reminderCall = scheduledCronCalls.find((c) => c.expr === "5 0 * * *");
    reminderCall!.cb();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onReminder).not.toHaveBeenCalled();
  });
});
