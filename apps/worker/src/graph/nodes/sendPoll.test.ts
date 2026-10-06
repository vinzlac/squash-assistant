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
  findPreviousPinnedAnnounce: vi.fn(async () => undefined),
  setJobRunAnnounceInfo: vi.fn(async () => {}),
}));

vi.mock("../pinning.js", () => ({
  pinBestEffort: vi.fn(async () => {}),
  unpinBestEffort: vi.fn(async () => true),
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
const { findPreviousPinnedAnnounce, setJobRunAnnounceInfo } = await import("../../jobRuns.js");
const { pinBestEffort, unpinBestEffort } = await import("../pinning.js");

const FULL_DAY_CLOSURE = [
  { startsAt: new Date("2026-08-14T22:00:00.000Z"), endsAt: new Date("2026-08-15T22:00:00.000Z"), label: "15 août" },
];

function rule(candidateStartTimes = ["18H45", "19H30"], pinMessagesEnabled = false): BookingRule {
  return {
    id: "test-rule",
    name: null,
    enabled: true,
    whatsappGroupJid: "group@test",
    resaSquashGroupId: "resa-1",
    targetWeekday: 2,
    pollDaysBefore: 7,
    pollTime: "10:00",
    decisionDaysBefore: 7,
    decisionTime: "21:30",
    confirmationDaysBefore: 7,
    confirmationTime: "22:30",
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
    confirmationNotifyWhatsappGroupJid: null,
    cronJitterWindowMinutes: 60,
    requireTelegramGoForAutoJobs: true,
    nextDayReminderEnabled: false,
    pinMessagesEnabled,
    startReminderEnabled: false,
    startReminderMinutesBefore: 120,
    jokerBookerId: null,
  };
}

function deps(closures: Array<{ startsAt: Date; endsAt: Date; label?: string | null }>): GraphDependencies {
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

function state(candidateStartTimes?: string[], pinMessagesEnabled = false): PipelineStateType {
  return {
    bookingRule: rule(candidateStartTimes, pinMessagesEnabled),
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
  reservationFailures: undefined,
  };
}

describe("createSendPollNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("envoie un message et termine sans sondage quand toutes les heures sont fermées", async () => {
    const closures = [
      { startsAt: new Date("2026-08-14T22:00:00.000Z"), endsAt: new Date("2026-08-15T22:00:00.000Z"), label: "15 août" },
    ];

    const result = await createSendPollNode(deps(closures))(state());

    expect(result).toEqual({ clubClosed: true });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "group@test",
      "Hello la team ! Le PUC est fermé samedi 15 août (15 août), donc pas de squash ce jour-là 😕 Pas de sondage cette semaine, on remet ça la semaine suivante 💪",
    );
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

  describe("épinglage", () => {
    it("épingle le sondage quand la règle l'active", async () => {
      await createSendPollNode(deps([]))(state(undefined, true));

      expect(pinBestEffort).toHaveBeenCalledWith(expect.anything(), "test-rule", "group@test", "msg-1", "du sondage");
    });

    it("n'épingle rien quand la règle ne l'active pas", async () => {
      await createSendPollNode(deps([]))(state());

      expect(pinBestEffort).not.toHaveBeenCalled();
    });

    it("désépingle l'annonce précédente avant d'envoyer le sondage, puis l'oublie", async () => {
      vi.mocked(findPreviousPinnedAnnounce).mockResolvedValueOnce({ jobId: "job-0", msgId: "ann-0", jid: "notify@test" });

      await createSendPollNode(deps([]))(state());

      expect(findPreviousPinnedAnnounce).toHaveBeenCalledWith(expect.anything(), "test-rule", "job-1");
      expect(unpinBestEffort).toHaveBeenCalledWith(expect.anything(), "test-rule", "notify@test", "ann-0", "de l'annonce précédente");
      expect(setJobRunAnnounceInfo).toHaveBeenCalledWith(expect.anything(), "job-0", null);
      expect(vi.mocked(unpinBestEffort).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(askPoll).mock.invocationCallOrder[0],
      );
    });

    it("garde l'annonce précédente en mémoire si le désépinglage échoue", async () => {
      vi.mocked(findPreviousPinnedAnnounce).mockResolvedValueOnce({ jobId: "job-0", msgId: "ann-0", jid: "notify@test" });
      vi.mocked(unpinBestEffort).mockResolvedValueOnce(false);

      await createSendPollNode(deps([]))(state());

      expect(setJobRunAnnounceInfo).not.toHaveBeenCalled();
    });

    it("PUC fermé : désépingle l'annonce précédente mais n'épingle pas le message de fermeture", async () => {
      vi.mocked(findPreviousPinnedAnnounce).mockResolvedValueOnce({ jobId: "job-0", msgId: "ann-0", jid: "notify@test" });

      const result = await createSendPollNode(deps(FULL_DAY_CLOSURE))(state(undefined, true));

      expect(result).toEqual({ clubClosed: true });
      expect(unpinBestEffort).toHaveBeenCalledWith(expect.anything(), "test-rule", "notify@test", "ann-0", "de l'annonce précédente");
      expect(pinBestEffort).not.toHaveBeenCalled();
    });
  });
});
