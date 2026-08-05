import { describe, expect, it, vi } from "vitest";
import { Command } from "@langchain/langgraph";
import type { JobRun } from "@squash-assistant/db/schema";
import type { BookingRule } from "../config.js";
import type { PipelineGraph } from "../graph/buildGraph.js";
import { resumeAfterPlanInterrupt } from "./scheduler.js";

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
