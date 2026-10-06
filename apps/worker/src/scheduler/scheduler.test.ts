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
    getJobRunById: vi.fn(),
    claimStartReminder: vi.fn(async () => true),
    releaseStartReminder: vi.fn(async () => {}),
  };
});
vi.mock("../bookingRules.js", () => ({
  loadBookingRules: vi.fn(async () => []),
  getBookingRuleById: vi.fn(),
}));
vi.mock("../mcp/huddleBot.js", () => ({
  sendMessage: vi.fn(async () => {}),
}));
vi.mock("../mcp/resaSquash.js", () => ({
  listGroupMembers: vi.fn(async () => ({ members: [] })),
}));
vi.mock("../graph/bookingQr.js", () => ({
  sendBookingQrCodes: vi.fn(async () => 1),
}));
vi.mock("../telegram/telegram.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../telegram/telegram.js")>();
  return { ...actual, sendTelegramMessage: vi.fn(async () => {}), waitForGoConfirmation: vi.fn(async () => true) };
});

import { claimStartReminder, findActiveJobRunForDate, getJobRunById, markNextDayReminderSent, releaseStartReminder } from "../jobRuns.js";
import { loadBookingRules } from "../bookingRules.js";
import { sendMessage } from "../mcp/huddleBot.js";
import { listGroupMembers } from "../mcp/resaSquash.js";
import { sendBookingQrCodes } from "../graph/bookingQr.js";
import { sendTelegramMessage, waitForGoConfirmation } from "../telegram/telegram.js";
import { __resetStartReminderLogForTests, triggerBookingConfirmation, triggerStartReminders } from "./scheduler.js";
import { START_REMINDER_SINCE, startReminderOffsetMinutes } from "./startReminder.js";

function rule(overrides: Partial<BookingRule> = {}): BookingRule {
  return {
    id: "test-rule",
    name: null,
    enabled: true,
    whatsappGroupJid: "g@test",
    resaSquashGroupId: "resa-1",
    targetWeekday: 2,
    pollDaysBefore: 7,
    pollTime: "10:00",
    decisionDaysBefore: 7,
    decisionTime: "21:30",
    confirmationDaysBefore: 7,
    confirmationTime: "22:30",
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

function job(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: "job-1",
    bookingRuleId: "test-rule",
    targetDate: "2026-08-11",
    pollRequestId: null,
    pollMsgId: null,
    announceMsgId: null,
    announceJid: null,
    cancelledAt: null,
    createdAt: new Date(),
    candidateStartTimes: null,
    ruleSnapshot: null,
    auto: true,
    nextDayReminderSentAt: null,
    startReminderSentAt: null,
    cancelReason: null,
    clubClosureId: null,
    ...overrides,
  };
}

describe("resumeAfterPlanInterrupt", () => {
  it("job auto + requireTelegramGoForAutoJobs=false → go-real sans polling", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const graph = { invoke } as unknown as PipelineGraph;
    const telegram = { botToken: "t", chatId: "c" };
    const config = { configurable: { thread_id: "test:job-1" } };
    vi.mocked(getJobRunById).mockResolvedValue(job());

    await resumeAfterPlanInterrupt(rule({ requireTelegramGoForAutoJobs: false }), job(), graph, telegram, config, {} as never);

    expect(invoke).toHaveBeenCalledWith(new Command({ resume: "go-real" }), config);
  });

  it("chemin rapide (sans go) mais job annulé entre-temps → ne reprend pas le graphe et logue", async () => {
    const invoke = vi.fn();
    const graph = { invoke } as unknown as PipelineGraph;
    const telegram = { botToken: "t", chatId: "c" };
    const config = { configurable: { thread_id: "test:job-1" } };
    vi.mocked(sendTelegramMessage).mockClear();
    vi.mocked(getJobRunById).mockResolvedValue(
      job({ cancelledAt: new Date("2026-09-12T10:00:00Z"), cancelReason: "PUC fermé : tournoi" }),
    );

    await resumeAfterPlanInterrupt(rule({ requireTelegramGoForAutoJobs: false }), job(), graph, telegram, config, {} as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledWith(telegram, '[test-rule] "go" ignoré — job du 2026-08-11 annulé (PUC fermé : tournoi).');
  });

  it("relecture du job en échec (DB) → fail closed : ne reprend pas le graphe et alerte Telegram", async () => {
    const invoke = vi.fn();
    const graph = { invoke } as unknown as PipelineGraph;
    const telegram = { botToken: "t", chatId: "c" };
    const config = { configurable: { thread_id: "test:job-1" } };
    vi.mocked(sendTelegramMessage).mockClear();
    vi.mocked(getJobRunById).mockRejectedValue(new Error("connection refused"));

    await resumeAfterPlanInterrupt(rule({ requireTelegramGoForAutoJobs: false }), job(), graph, telegram, config, {} as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      telegram,
      '[test-rule] Relecture du job du 2026-08-11 impossible avant reprise (connection refused) — reprise refusée par sécurité, relancer à la main depuis l\'UI.',
    );
  });

  it("« go » Telegram reçu après annulation du job → ne reprend pas le graphe et logue", async () => {
    const invoke = vi.fn();
    const graph = { invoke } as unknown as PipelineGraph;
    const telegram = { botToken: "t", chatId: "c" };
    const config = { configurable: { thread_id: "test:job-1" } };
    vi.mocked(waitForGoConfirmation).mockResolvedValue(true);
    vi.mocked(getJobRunById).mockResolvedValue(
      job({ cancelledAt: new Date("2026-09-12T10:00:00Z"), cancelReason: "PUC fermé : tournoi" }),
    );

    await resumeAfterPlanInterrupt(rule({ requireTelegramGoForAutoJobs: true }), job(), graph, telegram, config, {} as never);
    await vi.waitFor(() => expect(sendTelegramMessage).toHaveBeenCalledWith(telegram, expect.stringContaining("\"go\" ignoré")));

    expect(invoke).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledWith(telegram, '[test-rule] "go" ignoré — job du 2026-08-11 annulé (PUC fermé : tournoi).');
  });

  it("« go » Telegram sur un job toujours actif → reprend le graphe", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const graph = { invoke } as unknown as PipelineGraph;
    const telegram = { botToken: "t", chatId: "c" };
    const config = { configurable: { thread_id: "test:job-1" } };
    vi.mocked(waitForGoConfirmation).mockResolvedValue(true);
    vi.mocked(getJobRunById).mockResolvedValue(job());

    await resumeAfterPlanInterrupt(rule({ requireTelegramGoForAutoJobs: true }), job(), graph, telegram, config, {} as never);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    expect(invoke).toHaveBeenCalledWith(new Command({ resume: "go-real" }), config);
  });
});

describe("triggerBookingConfirmation", () => {
  const huddleBot = { client: {} as never, close: async () => {} };
  const resaSquash = { client: {} as never, close: async () => {} };
  const telegram = { botToken: "t", chatId: "c" };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T22:10:00Z")); // 2026-08-12 00h10 Paris → hier = 2026-08-11
    vi.mocked(findActiveJobRunForDate).mockReset();
    vi.mocked(markNextDayReminderSent).mockReset().mockResolvedValue(undefined);
    vi.mocked(sendMessage).mockReset().mockResolvedValue({});
    vi.mocked(sendTelegramMessage).mockClear();
    vi.mocked(listGroupMembers).mockReset().mockResolvedValue({ members: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ne fait rien si aucun job actif pour la date cible", async () => {
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(undefined);
    const graph = { getState: vi.fn() } as unknown as PipelineGraph;

    await triggerBookingConfirmation(rule(), graph, telegram, {} as never, huddleBot, resaSquash);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(markNextDayReminderSent).not.toHaveBeenCalled();
  });

  it("cherche le job via le décalage de la décision, pas celui stocké pour la confirmation", async () => {
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(undefined);
    const graph = { getState: vi.fn() } as unknown as PipelineGraph;

    await triggerBookingConfirmation(
      rule({ confirmationDaysBefore: 0, decisionDaysBefore: 5 }),
      graph,
      telegram,
      {} as never,
      huddleBot,
      resaSquash,
    );

    // 2026-08-12 Paris + 5 jours (décision), pas + 0 (ancien ancrage sur la date cible).
    expect(findActiveJobRunForDate).toHaveBeenCalledWith(expect.anything(), "test-rule", "2026-08-17");
  });

  it("ne fait rien si le rappel a déjà été envoyé pour ce job", async () => {
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(
      job({ nextDayReminderSentAt: new Date("2026-08-11T00:05:00Z") }),
    );
    const graph = { getState: vi.fn() } as unknown as PipelineGraph;

    await triggerBookingConfirmation(rule(), graph, telegram, {} as never, huddleBot, resaSquash);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(markNextDayReminderSent).not.toHaveBeenCalled();
  });

  it("ne fait rien si le job n'est pas dans l'état finished-announced", async () => {
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(job());
    const graph = {
      getState: vi.fn().mockResolvedValue({ next: ["waitForGoConfirmation"], values: {} }),
    } as unknown as PipelineGraph;

    await triggerBookingConfirmation(rule(), graph, telegram, {} as never, huddleBot, resaSquash);

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

    await triggerBookingConfirmation(rule(), graph, telegram, {} as never, huddleBot, resaSquash);

    expect(sendMessage).toHaveBeenCalledWith(
      huddleBot.client,
      "g@test",
      "✅ Confirmation — Réservation pour mardi\n\n" +
        "📅 2026-08-11\n\n" +
        "Court 4 : 18H45-19H30\n\n" +
        "Oui au sondage :\n" +
        "• 18H45 : Vincent Lacoste, Stéphane Martin",
    );
    expect(markNextDayReminderSent).toHaveBeenCalledWith({}, activeJob.id);
  });

  it("envoie la confirmation au groupe de notification des réservations", async () => {
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(job());
    const graph = {
      getState: vi.fn().mockResolvedValue({
        next: [],
        values: {
          pollRequestId: "poll-1",
          confirmedPlayerIdsByTime: { "18H45": ["vincent"] },
          bookingPlanGroups: [
            {
              startTime: "18H45",
              outOfWindowSessionIds: [],
              plan: {
                proposedBookings: [
                  { sessionId: "s1", court: 4, userId: "vincent", slotTime: "18H45", slotEndTime: "19H30" },
                ],
                warnings: [],
                meta: {} as never,
              },
            },
          ],
          goConfirmed: true,
          dryRun: true,
        },
      }),
    } as unknown as PipelineGraph;

    await triggerBookingConfirmation(
      rule({ confirmationNotifyWhatsappGroupJid: "notify@test" }),
      graph,
      telegram,
      {} as never,
      huddleBot,
      resaSquash,
    );

    expect(sendMessage).toHaveBeenCalledWith(huddleBot.client, "notify@test", expect.stringContaining("Oui au sondage"));
  });

  describe("destinataire de la confirmation (ADR-035)", () => {
    function announcedGraph(dryRun: boolean): PipelineGraph {
      return {
        getState: vi.fn().mockResolvedValue({
          next: [],
          values: {
            pollRequestId: "poll-1",
            confirmedPlayerIdsByTime: { "18H45": ["vincent"] },
            volunteerSubstituteIds: [],
            bookingPlanGroups: [
              {
                startTime: "18H45",
                outOfWindowSessionIds: [],
                plan: {
                  proposedBookings: [
                    { sessionId: "s1", court: 4, userId: "vincent", slotTime: "18H45", slotEndTime: "19H30" },
                  ],
                  warnings: [],
                  meta: {} as never,
                },
              },
            ],
            goConfirmed: true,
            dryRun,
          },
        }),
      } as unknown as PipelineGraph;
    }

    it("annonce sur le groupe de test, confirmation à null → groupe du sondage", async () => {
      vi.mocked(sendMessage).mockClear();
      vi.mocked(findActiveJobRunForDate).mockResolvedValue(job());

      await triggerBookingConfirmation(
        rule({ reservationNotifyWhatsappGroupJid: "annonce-test@g.us", confirmationNotifyWhatsappGroupJid: null }),
        announcedGraph(true),
        telegram,
        {} as never,
        huddleBot,
        resaSquash,
      );

      expect(sendMessage).toHaveBeenCalledWith(huddleBot.client, "g@test", expect.stringContaining("Oui au sondage"));
      expect(sendMessage).not.toHaveBeenCalledWith(huddleBot.client, "annonce-test@g.us", expect.anything());
    });

    it("réservation réelle : message et QR vont au même groupe de confirmation", async () => {
      vi.mocked(sendMessage).mockClear();
      vi.mocked(sendBookingQrCodes).mockClear();
      vi.mocked(findActiveJobRunForDate).mockResolvedValue(job());

      await triggerBookingConfirmation(
        rule({ reservationNotifyWhatsappGroupJid: "annonce-test@g.us", confirmationNotifyWhatsappGroupJid: "confirm@g.us" }),
        announcedGraph(false),
        telegram,
        {} as never,
        huddleBot,
        resaSquash,
      );

      expect(sendMessage).toHaveBeenCalledWith(huddleBot.client, "confirm@g.us", expect.stringContaining("Oui au sondage"));
      expect(sendBookingQrCodes).toHaveBeenCalledWith(expect.anything(), "confirm@g.us", expect.any(Array));
    });

    it("dry-run : aucun QR, message au groupe de confirmation", async () => {
      vi.mocked(sendMessage).mockClear();
      vi.mocked(sendBookingQrCodes).mockClear();
      vi.mocked(findActiveJobRunForDate).mockResolvedValue(job());

      await triggerBookingConfirmation(
        rule({ confirmationNotifyWhatsappGroupJid: "confirm@g.us" }),
        announcedGraph(true),
        telegram,
        {} as never,
        huddleBot,
        resaSquash,
      );

      expect(sendMessage).toHaveBeenCalledWith(huddleBot.client, "confirm@g.us", expect.any(String));
      expect(sendBookingQrCodes).not.toHaveBeenCalled();
    });
  });

  it("rejoue les QR d’accès avec un lien neuf (celui de la veille a expiré)", async () => {
    vi.mocked(sendBookingQrCodes).mockClear();
    const activeJob = job();
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(activeJob);
    const graph = {
      getState: vi.fn().mockResolvedValue({
        next: [],
        values: {
          pollRequestId: "poll-1",
          confirmedPlayerIdsByTime: { "18H45": ["vincent"] },
          volunteerSubstituteIds: [],
          bookingPlanGroups: [
            {
              startTime: "18H45",
              outOfWindowSessionIds: ["s2"],
              plan: {
                proposedBookings: [
                  { sessionId: "s1", court: 4, userId: "vincent", partnerId: "stephane", slotTime: "18H45", slotEndTime: "19H30" },
                  { sessionId: "s2", court: 1, userId: "vincent", partnerId: "stephane", slotTime: "18H45", slotEndTime: "19H30" },
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

    await triggerBookingConfirmation(rule(), graph, telegram, {} as never, huddleBot, resaSquash);

    // s2 est hors fenêtre : jamais réservé, donc pas de QR.
    expect(sendBookingQrCodes).toHaveBeenCalledWith(expect.anything(), "g@test", [
      expect.objectContaining({ sessionId: "s1" }),
    ]);
  });

  it("réservation partielle : le rappel et les QR ignorent les lignes refusées (2026-09-09)", async () => {
    vi.mocked(sendBookingQrCodes).mockClear();
    const activeJob = job();
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(activeJob);
    const graph = {
      getState: vi.fn().mockResolvedValue({
        next: [],
        values: {
          pollRequestId: "poll-1",
          confirmedPlayerIdsByTime: { "18H45": ["vincent"] },
          volunteerSubstituteIds: [],
          bookingPlanGroups: [
            {
              startTime: "18H45",
              outOfWindowSessionIds: [],
              plan: {
                proposedBookings: [
                  { sessionId: "s1", court: 4, userId: "vincent", partnerId: "stephane", slotTime: "18H45", slotEndTime: "19H30" },
                  { sessionId: "s2", court: 3, userId: "mustapha", partnerId: "stef", slotTime: "18H45", slotEndTime: "19H30" },
                ],
                warnings: [],
                meta: {} as never,
              },
            },
          ],
          goConfirmed: true,
          dryRun: false,
          announceMessage: "…",
          reservationFailures: [
            {
              sessionId: "s2",
              court: 3,
              slotTime: "18H45",
              slotEndTime: "19H30",
              userId: "mustapha",
              partnerId: "stef",
              reason: "PLAYER_BOOKING_LIMIT_REACHED",
              message: "crédits épuisés",
              rawError: "raw",
            },
          ],
        },
      }),
    } as unknown as PipelineGraph;

    await triggerBookingConfirmation(rule(), graph, telegram, {} as never, huddleBot, resaSquash);

    expect(sendMessage).toHaveBeenCalledWith(expect.anything(), "g@test", expect.stringContaining("Court 4 : 18H45-19H30"));
    expect(sendMessage).not.toHaveBeenCalledWith(expect.anything(), "g@test", expect.stringContaining("Court 3"));
    expect(sendBookingQrCodes).toHaveBeenCalledWith(expect.anything(), "g@test", [
      expect.objectContaining({ sessionId: "s1" }),
    ]);
  });

  it("ne rejoue pas de QR pour un job resté en dry-run", async () => {
    vi.mocked(sendBookingQrCodes).mockClear();
    const activeJob = job();
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(activeJob);
    const graph = {
      getState: vi.fn().mockResolvedValue({
        next: [],
        values: {
          pollRequestId: "poll-1",
          confirmedPlayerIdsByTime: { "18H45": ["vincent"] },
          volunteerSubstituteIds: [],
          bookingPlanGroups: [
            {
              startTime: "18H45",
              outOfWindowSessionIds: [],
              plan: {
                proposedBookings: [
                  { sessionId: "s1", court: 4, userId: "vincent", partnerId: "stephane", slotTime: "18H45", slotEndTime: "19H30" },
                ],
                warnings: [],
                meta: {} as never,
              },
            },
          ],
          goConfirmed: true,
          dryRun: true,
        },
      }),
    } as unknown as PipelineGraph;

    await triggerBookingConfirmation(rule(), graph, telegram, {} as never, huddleBot, resaSquash);

    expect(sendBookingQrCodes).not.toHaveBeenCalled();
  });

  it("n'expose pas les prête-noms mobilisés par le plan dans le rappel du groupe", async () => {
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

    await triggerBookingConfirmation(rule(), graph, telegram, {} as never, huddleBot, resaSquash);

    const sentMessage = vi.mocked(sendMessage).mock.calls[0]![2] as string;
    expect(sentMessage).not.toContain("Prête-nom");
    expect(sentMessage).not.toContain("julie");
  });
});

describe("triggerStartReminders", () => {
  const huddleBot = { client: {} as never, close: async () => {} };
  const resaSquash = { client: {} as never, close: async () => {} };
  const telegram = { botToken: "t", chatId: "c" };
  const JOB_ID = "job-rappel";
  const offset = startReminderOffsetMinutes(JOB_ID);
  // 2026-08-11 (mardi, UTC+2) ; premier créneau 18H45, délai 120 → envoi à 16h45 + offset Paris
  const atParis = (minutes: number) => new Date(Date.UTC(2026, 7, 10, 22, 0) + minutes * 60_000);
  const dueNow = atParis(18 * 60 + 45 - 120 + offset);

  function reminderRule(overrides: Partial<BookingRule> = {}): BookingRule {
    return rule({ startReminderEnabled: true, startReminderMinutesBefore: 120, confirmationNotifyWhatsappGroupJid: "confirm@g.us", ...overrides });
  }
  function reminderJob(overrides: Partial<JobRun> = {}): JobRun {
    return job({ id: JOB_ID, targetDate: "2026-08-11", createdAt: new Date(START_REMINDER_SINCE.getTime() + 1), ...overrides });
  }
  function announcedGraph(values: Record<string, unknown> = {}): PipelineGraph {
    return {
      getState: vi.fn().mockResolvedValue({
        next: [],
        values: {
          pollRequestId: "poll-1",
          bookingRule: reminderRule(),
          confirmedPlayerIdsByTime: { "18H45": ["vincent"] },
          bookingPlanGroups: [
            {
              startTime: "18H45",
              outOfWindowSessionIds: [],
              plan: {
                proposedBookings: [{ sessionId: "s1", court: 4, userId: "vincent", slotTime: "18H45", slotEndTime: "19H30" }],
                warnings: [],
                meta: {} as never,
              },
            },
          ],
          goConfirmed: true,
          dryRun: false,
          reservationFailures: [],
          ...values,
        },
      }),
    } as unknown as PipelineGraph;
  }

  beforeEach(() => {
    __resetStartReminderLogForTests();
    vi.mocked(loadBookingRules).mockReset().mockResolvedValue([reminderRule()]);
    vi.mocked(findActiveJobRunForDate).mockReset().mockResolvedValue(reminderJob());
    vi.mocked(claimStartReminder).mockReset().mockResolvedValue(true);
    vi.mocked(releaseStartReminder).mockReset().mockResolvedValue(undefined);
    vi.mocked(sendMessage).mockReset().mockResolvedValue({});
    vi.mocked(sendBookingQrCodes).mockClear();
    vi.mocked(sendTelegramMessage).mockClear();
    vi.mocked(listGroupMembers).mockReset().mockResolvedValue({ members: [] });
  });

  it("nominal réel : réserve, envoie le rappel au groupe de confirmation, puis les QR, puis logue", async () => {
    await triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash);

    expect(findActiveJobRunForDate).toHaveBeenCalledWith(expect.anything(), "test-rule", "2026-08-11");
    expect(claimStartReminder).toHaveBeenCalledWith({}, JOB_ID);
    expect(sendMessage).toHaveBeenCalledWith(huddleBot.client, "confirm@g.us", expect.stringMatching(/^⏰ Rappel — Squash aujourd'hui \(mardi\)/));
    expect(sendBookingQrCodes).toHaveBeenCalledWith(expect.anything(), "confirm@g.us", expect.any(Array));
    expect(sendTelegramMessage).toHaveBeenCalledWith(telegram, "[test-rule] Rappel avant match envoyé pour le 2026-08-11 (WhatsApp confirm@g.us).");
  });

  it("avant l'heure d'envoi : ne réserve rien", async () => {
    await triggerStartReminders(atParis(12 * 60), announcedGraph(), telegram, {} as never, huddleBot, resaSquash);
    expect(claimStartReminder).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("tick après le premier créneau (pod resté arrêté) : aucun envoi tardif", async () => {
    await triggerStartReminders(atParis(18 * 60 + 50), announcedGraph(), telegram, {} as never, huddleBot, resaSquash);
    expect(claimStartReminder).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("deux ticks concurrents : un seul envoi (la réservation n'est obtenue qu'une fois)", async () => {
    vi.mocked(claimStartReminder).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await Promise.all([
      triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash),
      triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash),
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("échec de sendMessage : libère la réservation, un seul log d'erreur sur deux ticks, puis envoi au tick suivant", async () => {
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("huddle down")).mockRejectedValueOnce(new Error("huddle down")).mockResolvedValue({});
    await triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash);
    await triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash);
    expect(releaseStartReminder).toHaveBeenCalledTimes(2);
    const errorLogs = vi.mocked(sendTelegramMessage).mock.calls.filter(([, text]) => String(text).includes("Rappel avant match non envoyé"));
    expect(errorLogs).toHaveLength(1);
    expect(sendBookingQrCodes).not.toHaveBeenCalled();

    await triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash);
    expect(sendBookingQrCodes).toHaveBeenCalledTimes(1);
  });

  it("dry-run vers le groupe du sondage : aucun envoi", async () => {
    vi.mocked(loadBookingRules).mockResolvedValue([reminderRule({ confirmationNotifyWhatsappGroupJid: null })]);
    await triggerStartReminders(dueNow, announcedGraph({ dryRun: true }), telegram, {} as never, huddleBot, resaSquash);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("dry-run vers un groupe de test : rappel dry-run, sans QR", async () => {
    await triggerStartReminders(dueNow, announcedGraph({ dryRun: true }), telegram, {} as never, huddleBot, resaSquash);
    expect(sendMessage).toHaveBeenCalledWith(huddleBot.client, "confirm@g.us", expect.stringMatching(/^⏰ Rappel \(dry-run — aucun court réservé\)/));
    expect(sendBookingQrCodes).not.toHaveBeenCalled();
  });

  it("job non annoncé le jour cible : un seul log Telegram sur plusieurs ticks, aucun envoi", async () => {
    const graph = { getState: vi.fn().mockResolvedValue({ next: ["waitForGoConfirmation"], values: { pollRequestId: "p" } }) } as unknown as PipelineGraph;
    await triggerStartReminders(atParis(1), graph, telegram, {} as never, huddleBot, resaSquash);
    await triggerStartReminders(atParis(2), graph, telegram, {} as never, huddleBot, resaSquash);
    const logs = vi.mocked(sendTelegramMessage).mock.calls.filter(([, text]) => String(text).includes("job non annoncé"));
    expect(logs).toHaveLength(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("job terminé sans annonce (rien à réserver) le jour cible : aucun log Telegram", async () => {
    const graph = { getState: vi.fn().mockResolvedValue({ next: [], values: { pollRequestId: "p", bookingPlanGroups: [] } }) } as unknown as PipelineGraph;
    await triggerStartReminders(atParis(1), graph, telegram, {} as never, huddleBot, resaSquash);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("règle éditée après le job : délai de la règle live, votes depuis le snapshot", async () => {
    // Live : délai 60 et candidateStartTimes sans 18H45 ; snapshot (état du graphe) : 18H45.
    vi.mocked(loadBookingRules).mockResolvedValue([reminderRule({ startReminderMinutesBefore: 60, candidateStartTimes: ["19H30"] })]);
    // À l'heure prévue pour 120 min, on est trop tôt pour 60 min → rien.
    await triggerStartReminders(dueNow, announcedGraph({ bookingRule: reminderRule({ candidateStartTimes: ["18H45"] }) }), telegram, {} as never, huddleBot, resaSquash);
    expect(sendMessage).not.toHaveBeenCalled();

    await triggerStartReminders(
      atParis(18 * 60 + 45 - 60 + offset),
      announcedGraph({ bookingRule: reminderRule({ candidateStartTimes: ["18H45"] }) }),
      telegram,
      {} as never,
      huddleBot,
      resaSquash,
    );
    expect(sendMessage).toHaveBeenCalledWith(huddleBot.client, "confirm@g.us", expect.stringContaining("• 18H45 : vincent"));
  });

  it("plusieurs jobs pour la date : seul le job actif (findActiveJobRunForDate) est traité", async () => {
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(reminderJob({ id: JOB_ID }));
    await triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash);
    expect(findActiveJobRunForDate).toHaveBeenCalledTimes(1);
    expect(claimStartReminder).toHaveBeenCalledTimes(1);
    expect(claimStartReminder).toHaveBeenCalledWith({}, JOB_ID);
  });

  it("règle sans rappel activé : ne cherche même pas de job", async () => {
    vi.mocked(loadBookingRules).mockResolvedValue([reminderRule({ startReminderEnabled: false })]);
    await triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash);
    expect(findActiveJobRunForDate).not.toHaveBeenCalled();
  });
});
