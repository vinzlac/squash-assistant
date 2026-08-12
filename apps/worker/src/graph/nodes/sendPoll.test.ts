import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingRule } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

vi.mock("../../mcp/huddleBot.js", () => ({
  askPoll: vi.fn(async () => ({ requestId: "poll-1", msgId: "msg-1" })),
  sendMessage: vi.fn(async () => {}),
}));

vi.mock("../../jobRuns.js", () => ({
  setJobRunPollInfo: vi.fn(async () => {}),
}));

vi.mock("../../telegram/telegram.js", () => ({
  sendTelegramMessage: vi.fn(async () => {}),
}));

vi.mock("../emitEvent.js", () => ({
  withEventLogging: vi.fn(async (_deps, _event, action) => {
    const { result } = await action();
    return result;
  }),
}));

const { createSendPollNode } = await import("./sendPoll.js");
const { askPoll, sendMessage } = await import("../../mcp/huddleBot.js");
const { withEventLogging } = await import("../emitEvent.js");

function rule(candidateStartTimes = ["18H45", "19H30"]): BookingRule {
  return {
    id: "test-rule",
    name: null,
    enabled: true,
    whatsappGroupJid: "group@test",
    resaSquashGroupId: "resa-1",
    pollCron: "0 10 * * 2",
    decisionCron: "30 21 * * 2",
    targetWeekdayOffset: 7,
    candidateStartTimes,
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
  };
}

function deps(closures: Array<{ startsAt: Date; endsAt: Date }>): GraphDependencies {
  const db = {
    select: () => ({
      from: () => ({
        where: async () => closures,
      }),
    }),
    insert: () => ({ values: async () => {} }),
  };
  return {
    huddleBot: { client: {} as never, close: async () => {} },
    resaSquash: { client: {} as never, close: async () => {} },
    telegram: { botToken: "test-token", chatId: "test-chat" },
    db: db as never,
  };
}

function state(candidateStartTimes?: string[]): PipelineStateType {
  return {
    bookingRule: rule(candidateStartTimes),
    jobRunId: "job-1",
    targetDate: "2026-08-15",
    pollRequestId: undefined,
    clubClosed: undefined,
    confirmedPlayerIdsByTime: {},
    volunteerSubstituteIds: [],
    bookingPlanGroups: undefined,
    goConfirmed: false,
    dryRun: true,
    announceMessage: undefined,
  };
}

describe("createSendPollNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("envoie un message et termine sans sondage quand toutes les heures sont fermées", async () => {
    const closures = [
      { startsAt: new Date("2026-08-14T22:00:00.000Z"), endsAt: new Date("2026-08-15T22:00:00.000Z") },
    ];

    const result = await createSendPollNode(deps(closures))(state());

    expect(result).toEqual({ clubClosed: true });
    expect(sendMessage).toHaveBeenCalledWith(expect.anything(), "group@test", "puc fermé samedi 15 août pas de squash");
    expect(askPoll).not.toHaveBeenCalled();
    expect(withEventLogging).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "club-closed", targetDate: "2026-08-15" }),
      expect.any(Function),
    );
  });

  it("sonde uniquement les heures ouvertes et signale les heures fermées", async () => {
    const closures = [
      { startsAt: new Date("2026-08-14T22:00:00.000Z"), endsAt: new Date("2026-08-15T17:00:00.000Z") },
    ];

    const result = await createSendPollNode(deps(closures))(state());

    expect(result).toEqual({ pollRequestId: "poll-1", clubClosed: false });
    expect(askPoll).toHaveBeenCalledWith(
      expect.anything(),
      "group@test",
      "Squash samedi 15 août à 19h30 ? (18h45 : puc fermé)",
      ["19H30", "Non", "Non, mais je peux prêter mon nom"],
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("conserve toutes les heures candidates lorsqu'aucune fermeture ne chevauche la date", async () => {
    const result = await createSendPollNode(deps([]))(state());

    expect(result).toEqual({ pollRequestId: "poll-1", clubClosed: false });
    expect(askPoll).toHaveBeenCalledWith(
      expect.anything(),
      "group@test",
      "Squash samedi 15 août, à quelle heure : 18h45 ou 19h30 ?",
      ["18H45", "19H30", "Non", "Non, mais je peux prêter mon nom"],
    );
  });
});
