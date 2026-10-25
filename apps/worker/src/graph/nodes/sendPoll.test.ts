import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  findPreviousPinnedRecap: vi.fn(async () => undefined),
  setJobRunRecapInfo: vi.fn(async () => {}),
  findPreviousJobWithRoster: vi.fn(async () => undefined),
}));

vi.mock("../../roster/publishRoster.js", () => ({
  withdrawRoster: vi.fn(async () => true),
  retryOrphanUnpin: vi.fn(async () => {}),
}));

vi.mock("../../roster/rosterStore.js", () => ({
  setPollUnpinnedAt: vi.fn(async () => {}),
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
const { POLL_CLOSURE_MARKER } = await import("./pollQuestion.js");
const { askPoll, sendMessage } = await import("../../mcp/huddleBot.js");
const { sendTelegramMessage } = await import("../../telegram/telegram.js");
const { withEventLogging } = await import("../emitEvent.js");
const { findPreviousJobWithRoster, findPreviousPinnedAnnounce, findPreviousPinnedRecap, setJobRunAnnounceInfo, setJobRunRecapInfo } =
  await import("../../jobRuns.js");
const { withdrawRoster, retryOrphanUnpin } = await import("../../roster/publishRoster.js");
const { setPollUnpinnedAt } = await import("../../roster/rosterStore.js");
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
    unresolvedVoters: [], voterNames: {},
    bookingPlanGroups: undefined,
    goConfirmed: false,
    dryRun: true,
    announceMessage: undefined,
  reservationFailures: undefined,
  };
}

/** Date fixe : le sondage ne dépend plus de l'heure d'envoi (plus de mention de clôture). */
const AFTER_CLOSURE = new Date("2026-08-10T08:00:00Z");

describe("createSendPollNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AFTER_CLOSURE);
  });

  afterEach(() => vi.useRealTimers());

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

  describe("plus de mention de clôture (spec roster-desistements §4.1)", () => {
    // Changement de règle voulu : l'ancienne mention « réponses jusqu'au » n'est plus envoyée,
    // quelle que soit l'heure d'envoi (anciens tests de mention/48 h/règle live supprimés).
    it.each(["2026-08-07T08:00:00Z", "2026-08-06T20:30:00Z", "2026-08-06T18:30:00Z"])(
      "question envoyée sans « réponses jusqu'au » (envoi à %s)",
      async (sentAt) => {
        vi.setSystemTime(new Date(sentAt));

        await createSendPollNode(deps([]))(state());

        const question = vi.mocked(askPoll).mock.calls[0]![2];
        expect(question).not.toContain(POLL_CLOSURE_MARKER);
        expect(question).toBe("Squash samedi 15 août, à quelle heure : 18h45 ou 19h30 ?");
      },
    );
  });

  describe("nettoyage du job précédent (ADR-034 point 4)", () => {
    function previousJob(overrides: Record<string, unknown> = {}) {
      return {
        id: "job-0",
        pollMsgId: "poll-0",
        pollUnpinnedAt: null,
        rosterPhoto: { votes: [] },
        rosterMsgId: "roster-0",
        rosterJid: "roster@test",
        rosterOrphan: { msgId: "old", jid: "roster@test", expiresAt: "2026-08-20T00:00:00.000Z" },
        ruleSnapshot: { whatsappGroupJid: "snapshot-group@test" },
        ...overrides,
      } as never;
    }

    it("désépingle le sondage (poll_unpinned_at écrit), désépingle le roster sans le supprimer, retente l'orphelin", async () => {
      const job = previousJob();
      vi.mocked(findPreviousJobWithRoster).mockResolvedValueOnce(job);

      await createSendPollNode(deps([]))(state());

      expect(findPreviousJobWithRoster).toHaveBeenCalledWith(expect.anything(), "test-rule", "job-1");
      expect(unpinBestEffort).toHaveBeenCalledWith(expect.anything(), "test-rule", "snapshot-group@test", "poll-0", "du sondage précédent");
      expect(setPollUnpinnedAt).toHaveBeenCalledWith(expect.anything(), "job-0", expect.any(Date));
      // unpinOnly : msgId et empreinte du roster conservés, donc pas de republication au tick.
      expect(withdrawRoster).toHaveBeenCalledWith(
        expect.objectContaining({ job, pinEnabled: false, notifyJid: "roster@test" }),
        { unpinOnly: true },
      );
      expect(retryOrphanUnpin).toHaveBeenCalledWith(expect.objectContaining({ job, pinEnabled: false }));
      expect(vi.mocked(retryOrphanUnpin).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(askPoll).mock.invocationCallOrder[0]);
    });

    it("indépendant de pinMessagesEnabled", async () => {
      vi.mocked(findPreviousJobWithRoster).mockResolvedValueOnce(previousJob());

      await createSendPollNode(deps([]))(state(undefined, false));

      expect(withdrawRoster).toHaveBeenCalled();
    });

    it("sondage non désépinglé : poll_unpinned_at n'est pas écrit (la passe du tick réessaie)", async () => {
      vi.mocked(findPreviousJobWithRoster).mockResolvedValueOnce(previousJob());
      vi.mocked(unpinBestEffort).mockResolvedValueOnce(false);

      await createSendPollNode(deps([]))(state());

      expect(setPollUnpinnedAt).not.toHaveBeenCalled();
      expect(withdrawRoster).toHaveBeenCalled();
    });

    it("sans snapshot de règle : groupe de la règle courante ; sans rosterJid : notifyJid = groupe du sondage", async () => {
      vi.mocked(findPreviousJobWithRoster).mockResolvedValueOnce(
        previousJob({ ruleSnapshot: null, rosterJid: null, rosterOrphan: null }),
      );

      await createSendPollNode(deps([]))(state());

      expect(unpinBestEffort).toHaveBeenCalledWith(expect.anything(), "test-rule", "group@test", "poll-0", "du sondage précédent");
      expect(withdrawRoster).toHaveBeenCalledWith(expect.objectContaining({ notifyJid: "group@test" }), { unpinOnly: true });
      expect(retryOrphanUnpin).not.toHaveBeenCalled();
    });

    it("claim pris : simple Telegram, le sondage part quand même", async () => {
      vi.mocked(findPreviousJobWithRoster).mockResolvedValueOnce(previousJob());
      vi.mocked(withdrawRoster).mockResolvedValueOnce(false);

      await createSendPollNode(deps([]))(state());

      expect(sendTelegramMessage).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Roster précédent en cours de publication"));
      expect(askPoll).toHaveBeenCalled();
    });

    it("une erreur de nettoyage est signalée sur Telegram et n'empêche ni les autres étapes ni le sondage", async () => {
      vi.mocked(findPreviousJobWithRoster).mockResolvedValueOnce(previousJob());
      vi.mocked(withdrawRoster).mockRejectedValueOnce(new Error("db down"));

      await createSendPollNode(deps([]))(state());

      expect(sendTelegramMessage).toHaveBeenCalledWith(expect.anything(), "[test-rule] Nettoyage du roster précédent échoué : db down");
      expect(retryOrphanUnpin).toHaveBeenCalled();
      expect(askPoll).toHaveBeenCalled();
    });

    it("aucun job précédent à nettoyer : rien n'est appelé", async () => {
      await createSendPollNode(deps([]))(state());

      expect(withdrawRoster).not.toHaveBeenCalled();
      expect(retryOrphanUnpin).not.toHaveBeenCalled();
    });
  });

  describe("épinglage", () => {
    it("désépingle le récap précédent resté épinglé, indépendamment de la case, puis l'oublie", async () => {
      vi.mocked(findPreviousPinnedRecap).mockResolvedValueOnce({ jobId: "job-0", msgId: "recap-0", jid: "notify@test" });

      await createSendPollNode(deps([]))(state());

      expect(findPreviousPinnedRecap).toHaveBeenCalledWith(expect.anything(), "test-rule", "job-1");
      expect(unpinBestEffort).toHaveBeenCalledWith(expect.anything(), "test-rule", "notify@test", "recap-0", "du récap précédent");
      expect(setJobRunRecapInfo).toHaveBeenCalledWith(expect.anything(), "job-0", null);
    });

    it("un échec du nettoyage du récap précédent n'empêche pas le sondage et est signalé sur Telegram", async () => {
      vi.mocked(findPreviousPinnedRecap).mockRejectedValueOnce(new Error("db down"));

      await createSendPollNode(deps([]))(state());

      expect(askPoll).toHaveBeenCalled();
      expect(sendTelegramMessage).toHaveBeenCalledWith(
        expect.anything(),
        "[test-rule] Nettoyage du récap précédent échoué : db down",
      );
    });

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
