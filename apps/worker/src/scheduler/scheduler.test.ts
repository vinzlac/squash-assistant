import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "@langchain/langgraph";
import type { JobRun } from "@squash-assistant/db/schema";
import type { BookingRule } from "../config.js";
import type { PipelineGraph } from "../graph/buildGraph.js";
import { resumeAfterPlanInterrupt } from "./scheduler.js";

vi.mock("../jobRuns.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jobRuns.js")>();
  return {
    ...actual,
    findActiveJobRunForDate: vi.fn(),
    markNextDayReminderSent: vi.fn(async () => {}),
  };
});
vi.mock("../mcp/huddleBot.js", () => ({
  sendMessage: vi.fn(async () => {}),
}));
vi.mock("../mcp/resaSquash.js", () => ({
  listGroupMembers: vi.fn(async () => ({ members: [] })),
}));
vi.mock("../telegram/telegram.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../telegram/telegram.js")>();
  return { ...actual, sendTelegramMessage: vi.fn(async () => {}) };
});

import { findActiveJobRunForDate, markNextDayReminderSent } from "../jobRuns.js";
import { sendMessage } from "../mcp/huddleBot.js";
import { listGroupMembers } from "../mcp/resaSquash.js";
import { sendTelegramMessage } from "../telegram/telegram.js";
import { triggerNextDayReminder } from "./scheduler.js";

function rule(overrides: Partial<BookingRule> = {}): BookingRule {
  return {
    id: "test-rule",
    name: null,
    enabled: true,
    whatsappGroupJid: "g@test",
    resaSquashGroupId: "resa-1",
    pollCron: "0 10 * * 2",
    decisionCron: "30 21 * * 2",
    targetWeekdayOffset: 7,
    candidateStartTimes: ["18H45"],
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
    ...overrides,
  };
}

function job(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: "job-1",
    bookingRuleId: "test-rule",
    targetDate: "2026-08-11",
    pollRequestId: null,
    pollMsgId: null,
    cancelledAt: null,
    createdAt: new Date(),
    candidateStartTimes: null,
    ruleSnapshot: null,
    auto: true,
    nextDayReminderSentAt: null,
    ...overrides,
  };
}

describe("resumeAfterPlanInterrupt", () => {
  it("job auto + requireTelegramGoForAutoJobs=false → go-real sans polling", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const graph = { invoke } as unknown as PipelineGraph;
    const telegram = { botToken: "t", chatId: "c" };
    const config = { configurable: { thread_id: "test:job-1" } };

    await resumeAfterPlanInterrupt(rule({ requireTelegramGoForAutoJobs: false }), job(), graph, telegram, config);

    expect(invoke).toHaveBeenCalledWith(new Command({ resume: "go-real" }), config);
  });

  it("job auto + requireTelegramGoForAutoJobs=true → n'appelle pas invoke (polling Telegram)", async () => {
    const invoke = vi.fn();
    const graph = { invoke } as unknown as PipelineGraph;
    const telegram = { botToken: "t", chatId: "c" };
    const config = { configurable: { thread_id: "test:job-1" } };

    await resumeAfterPlanInterrupt(rule({ requireTelegramGoForAutoJobs: true }), job(), graph, telegram, config);

    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("triggerNextDayReminder", () => {
  const huddleBot = { client: {} as never, close: async () => {} };
  const resaSquash = { client: {} as never, close: async () => {} };
  const telegram = { botToken: "t", chatId: "c" };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T22:10:00Z")); // 2026-08-12 00h10 Paris → hier = 2026-08-11
    vi.mocked(findActiveJobRunForDate).mockReset();
    vi.mocked(markNextDayReminderSent).mockReset().mockResolvedValue(undefined);
    vi.mocked(sendMessage).mockReset().mockResolvedValue(undefined);
    vi.mocked(sendTelegramMessage).mockClear();
    vi.mocked(listGroupMembers).mockReset().mockResolvedValue({ members: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ne fait rien si aucun job actif pour la date cible", async () => {
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(undefined);
    const graph = { getState: vi.fn() } as unknown as PipelineGraph;

    await triggerNextDayReminder(rule(), graph, telegram, {} as never, huddleBot, resaSquash);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(markNextDayReminderSent).not.toHaveBeenCalled();
  });

  it("ne fait rien si le rappel a déjà été envoyé pour ce job", async () => {
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(
      job({ nextDayReminderSentAt: new Date("2026-08-11T00:05:00Z") }),
    );
    const graph = { getState: vi.fn() } as unknown as PipelineGraph;

    await triggerNextDayReminder(rule(), graph, telegram, {} as never, huddleBot, resaSquash);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(markNextDayReminderSent).not.toHaveBeenCalled();
  });

  it("ne fait rien si le job n'est pas dans l'état finished-announced", async () => {
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(job());
    const graph = {
      getState: vi.fn().mockResolvedValue({ next: ["waitForGoConfirmation"], values: {} }),
    } as unknown as PipelineGraph;

    await triggerNextDayReminder(rule(), graph, telegram, {} as never, huddleBot, resaSquash);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(markNextDayReminderSent).not.toHaveBeenCalled();
  });

  it("recalcule le message (résumé courts + votes résolus en noms) et marque le rappel comme envoyé", async () => {
    const activeJob = job();
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(activeJob);
    vi.mocked(listGroupMembers).mockResolvedValue({
      members: [
        {
          group_id: "resa-1",
          user_id: "vincent",
          licensee_id: "l1",
          added_at: "2026-01-01",
          role: "member",
          first_name: "Vincent",
          last_name: "Lacoste",
        },
        {
          group_id: "resa-1",
          user_id: "stephane",
          licensee_id: "l2",
          added_at: "2026-01-01",
          role: "member",
          first_name: "Stéphane",
          last_name: "Martin",
        },
      ],
    });
    const graph = {
      getState: vi.fn().mockResolvedValue({
        next: [],
        values: {
          pollRequestId: "poll-1",
          confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane"] },
          volunteerSubstituteIds: [],
          bookingPlanGroups: [
            {
              startTime: "18H45",
              outOfWindowSessionIds: [],
              plan: {
                proposedBookings: [
                  {
                    sessionId: "s1",
                    court: 4,
                    userId: "vincent",
                    partnerId: "stephane",
                    slotTime: "18H45",
                    slotEndTime: "19H30",
                  },
                ],
                warnings: [],
                meta: {} as never,
              },
            },
          ],
          goConfirmed: true,
          dryRun: false,
        },
      }),
    } as unknown as PipelineGraph;

    await triggerNextDayReminder(rule(), graph, telegram, {} as never, huddleBot, resaSquash);

    expect(sendMessage).toHaveBeenCalledWith(
      huddleBot.client,
      "g@test",
      "🔔 Rappel — 🏸 Réservation(s) confirmée(s) « test-rule »\n\n" +
        "📅 2026-08-11\n\n" +
        "Court 4 : 18H45-19H30\n\n" +
        "Votes reçus :\n" +
        "• 18H45 : Vincent Lacoste, Stéphane Martin\n\n" +
        "🤖 Réservation effectuée automatiquement par squash-assistant.\n\n" +
        "Le sondage WhatsApp est maintenant clôturé.",
    );
    expect(markNextDayReminderSent).toHaveBeenCalledWith({}, activeJob.id);
  });

  it("ajoute le bloc prête-nom(s) utilisé(s) uniquement si le plan a dû en mobiliser", async () => {
    const activeJob = job();
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(activeJob);
    const graph = {
      getState: vi.fn().mockResolvedValue({
        next: [],
        values: {
          pollRequestId: "poll-1",
          confirmedPlayerIdsByTime: { "18H45": ["vincent"] },
          volunteerSubstituteIds: ["julie"],
          bookingPlanGroups: [
            {
              startTime: "18H45",
              outOfWindowSessionIds: [],
              plan: {
                proposedBookings: [
                  {
                    sessionId: "s1",
                    court: 4,
                    userId: "vincent",
                    partnerId: "julie",
                    slotTime: "18H45",
                    slotEndTime: "19H30",
                  },
                ],
                warnings: [],
                meta: {} as never,
              },
            },
          ],
          goConfirmed: true,
          dryRun: false,
        },
      }),
    } as unknown as PipelineGraph;

    await triggerNextDayReminder(rule(), graph, telegram, {} as never, huddleBot, resaSquash);

    const sentMessage = vi.mocked(sendMessage).mock.calls[0]![2] as string;
    expect(sentMessage).toContain("Prête-nom(s) utilisé(s) :\n• 18H45 : julie");
  });
});
