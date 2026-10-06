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

vi.mock("./cronJitter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cronJitter.js")>();
  return {
    ...actual,
    scheduleWithCronJitter: vi.fn((_label: string, _windowMinutes: number, fn: () => Promise<void>) => {
      // Reflète le self-catch de la vraie implémentation (schedule(() => { void fn().catch(() => {}) }))
      void fn().catch(() => {});
    }),
  };
});

import { scheduleWithCronJitter } from "./cronJitter.js";
import { getBookingRuleById } from "../bookingRules.js";

function rule(overrides: Partial<BookingRule> = {}): BookingRule {
  return {
    id: "r1",
    name: "R1",
    enabled: true,
    whatsappGroupJid: "g@test",
    resaSquashGroupId: "resa",
    targetWeekday: 2,
    pollDaysBefore: 7,
    pollTime: "10:00",
    decisionDaysBefore: 7,
    decisionTime: "21:30",
    confirmationDaysBefore: 7,
    confirmationTime: "22:30",
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
  jokerBookerId: null,
    unexpectedPlayersMargin: 0,
    reservationNotifyWhatsappGroupJid: null,
    confirmationNotifyWhatsappGroupJid: null,
    cronJitterWindowMinutes: 60,
    requireTelegramGoForAutoJobs: true,
    nextDayReminderEnabled: false,
    pinMessagesEnabled: false,
    startReminderEnabled: false,
    startReminderMinutesBefore: 120,
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
      onConfirmation: async () => {},
      onStartReminderTick: async () => {},
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
      onConfirmation: async () => {},
      onStartReminderTick: async () => {},
    });
    expect(getScheduledRuleIds()).toEqual([]);

    vi.mocked(loadBookingRules).mockResolvedValue([rule({ id: "r2", enabled: true })]);
    const result = await reloadScheduler();
    expect(result.enabledRuleIds).toEqual(["r2"]);
    expect(getScheduledRuleIds()).toEqual(["r2"]);
  });

  it("dérive les crons du jour cible : samedi, sondage J-4 → mardi 10:00, décision J-2 → jeudi 21:30", async () => {
    scheduledCronCalls.length = 0;
    startCronRegistry(
      [rule({ id: "samedi", targetWeekday: 6, pollDaysBefore: 4, pollTime: "10:00", decisionDaysBefore: 2, decisionTime: "21:30", confirmationDaysBefore: 2, confirmationTime: "22:30" })],
      { graph: {} as never, telegram: {} as never, db: {} as never, onPoll: vi.fn(async () => {}), onDecision: vi.fn(async () => {}), onConfirmation: vi.fn(async () => {}), onStartReminderTick: async () => {} },
    );
    expect(scheduledCronCalls.map((c) => c.expr)).toEqual(["0 10 * * 2", "30 21 * * 4", "20 22 * * 4", "* * * * *"]);
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
    const testRule = rule();
    vi.mocked(getBookingRuleById).mockResolvedValue(testRule);

    startCronRegistry([testRule], {
      graph: {} as never,
      telegram: { botToken: "t", chatId: "c" },
      db: {} as never,
      onPoll,
      onDecision,
      onConfirmation: async () => {},
      onStartReminderTick: async () => {},
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
    const onConfirmation = vi.fn(async () => {});
    const enabledRule = rule({ nextDayReminderEnabled: true });
    vi.mocked(getBookingRuleById).mockResolvedValue(enabledRule);

    startCronRegistry([enabledRule], {
      graph: {} as never,
      telegram: { botToken: "t", chatId: "c" },
      db: {} as never,
      onPoll,
      onDecision,
      onConfirmation,
      onStartReminderTick: async () => {},
    });

    const reminderCall = scheduledCronCalls.find((c) => c.expr === "20 22 * * 2");
    expect(reminderCall).toBeDefined();

    reminderCall!.cb();
    await vi.waitFor(() => {
      expect(onConfirmation).toHaveBeenCalledWith(enabledRule);
    });
    const confirmationJitter = vi
      .mocked(scheduleWithCronJitter)
      .mock.calls.find((c) => c[0] === `${enabledRule.id} confirmationCron`);
    expect(confirmationJitter?.[1]).toBe(20);
  });

  it("contient l'erreur si onDecision rejette, sans laisser la rejection se propager", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onDecision = vi.fn(async () => {
      throw new Error("boom decision");
    });
    const testRule = rule();
    vi.mocked(getBookingRuleById).mockResolvedValue(testRule);

    startCronRegistry([testRule], {
      graph: {} as never,
      telegram: { botToken: "t", chatId: "c" },
      db: {} as never,
      onPoll: async () => {},
      onDecision,
      onConfirmation: async () => {},
      onStartReminderTick: async () => {},
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
    const testRule = rule();
    vi.mocked(getBookingRuleById).mockResolvedValue(testRule);

    startCronRegistry([testRule], {
      graph: {} as never,
      telegram: { botToken: "t", chatId: "c" },
      db: {} as never,
      onPoll,
      onDecision: async () => {},
      onConfirmation: async () => {},
      onStartReminderTick: async () => {},
    });

    const pollCall = scheduledCronCalls.find((c) => c.expr === "0 10 * * 2");
    expect(pollCall).toBeDefined();

    expect(() => pollCall!.cb()).not.toThrow();
    await vi.waitFor(() => {
      expect(onPoll).toHaveBeenCalledWith(testRule);
    });

    consoleErrorSpy.mockRestore();
  });

  it("n'appelle pas onConfirmation si nextDayReminderEnabled est false", async () => {
    const onConfirmation = vi.fn(async () => {});
    const disabledRule = rule({ nextDayReminderEnabled: false });
    vi.mocked(getBookingRuleById).mockResolvedValue(disabledRule);

    startCronRegistry([disabledRule], {
      graph: {} as never,
      telegram: { botToken: "t", chatId: "c" },
      db: {} as never,
      onPoll: async () => {},
      onDecision: async () => {},
      onConfirmation,
      onStartReminderTick: async () => {},
    });

    const reminderCall = scheduledCronCalls.find((c) => c.expr === "20 22 * * 2");
    reminderCall!.cb();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onConfirmation).not.toHaveBeenCalled();
  });
});

describe("tick global du rappel avant le match", () => {
  beforeEach(() => {
    __resetCronRegistryForTests();
    scheduledCronCalls.length = 0;
    vi.mocked(loadBookingRules).mockReset();
  });

  afterEach(() => {
    __resetCronRegistryForTests();
  });

  const runtime = (onStartReminderTick: (now: Date) => Promise<void>) => ({
    graph: {} as never,
    telegram: { botToken: "t", chatId: "c" },
    db: {} as never,
    onPoll: async () => {},
    onDecision: async () => {},
    onConfirmation: async () => {},
    onStartReminderTick,
  });

  it("un seul tick, même après plusieurs startCronRegistry et un reload", async () => {
    startCronRegistry([], runtime(async () => {}));
    startCronRegistry([], runtime(async () => {}));
    vi.mocked(loadBookingRules).mockResolvedValue([rule({ enabled: true })]);
    await reloadScheduler();

    const ticks = scheduledCronCalls.filter((c) => c.expr === "* * * * *");
    expect(ticks).toHaveLength(2); // un par startCronRegistry
    const cron = (await import("node-cron")).default;
    const tickHandles = vi.mocked(cron.schedule).mock.results
      .filter((_, i) => vi.mocked(cron.schedule).mock.calls[i]?.[0] === "* * * * *")
      .map((r) => r.value as { stop: ReturnType<typeof vi.fn> });
    expect(tickHandles.at(-2)!.stop).toHaveBeenCalled(); // l'ancien est arrêté
    expect(tickHandles.at(-1)!.stop).not.toHaveBeenCalled(); // le courant survit au reload
  });

  it("le tick appelle onStartReminderTick avec l'instant courant et avale ses erreurs", async () => {
    const onTick = vi.fn(async () => {
      throw new Error("boom");
    });
    startCronRegistry([], runtime(onTick));
    const tick = scheduledCronCalls.find((c) => c.expr === "* * * * *")!;
    expect(() => tick.cb()).not.toThrow();
    await Promise.resolve();
    expect(onTick).toHaveBeenCalledWith(expect.any(Date));
  });

  it("ne chevauche pas : un tick encore en cours bloque le suivant", async () => {
    let release: () => void = () => {};
    const onTick = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    startCronRegistry([], runtime(onTick));
    const tick = scheduledCronCalls.find((c) => c.expr === "* * * * *")!;
    tick.cb();
    tick.cb();
    expect(onTick).toHaveBeenCalledTimes(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    tick.cb();
    expect(onTick).toHaveBeenCalledTimes(2);
    release();
  });

  it("le reset de test arrête le tick", async () => {
    startCronRegistry([], runtime(async () => {}));
    const cron = (await import("node-cron")).default;
    const handle = vi.mocked(cron.schedule).mock.results.at(-1)!.value as { stop: ReturnType<typeof vi.fn> };
    __resetCronRegistryForTests();
    expect(handle.stop).toHaveBeenCalled();
  });
});
