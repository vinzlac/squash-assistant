import { describe, expect, it, vi } from "vitest";
import type { BookingRule } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../dependencies.js";
import type { BookingPlanGroup, PipelineStateType } from "../state.js";

function group(overrides: Partial<BookingPlanGroup> = {}): BookingPlanGroup {
  return {
    startTime: "18H45",
    plan: {
      dryRun: true,
      proposedBookings: [
        {
          sessionId: "s1",
          court: 4,
          userId: "vincent",
          partnerId: "stephane",
          slotTime: "18H45",
          slotEndTime: "19H30",
          startDate: "2026-07-21T18:45:00+02:00",
        },
      ],
      warnings: [],
      meta: {
        courtsNeeded: 1,
        roundsPlanned: 1,
        dryRun: true,
        groupLabel: "squashacademie-mardi",
        recurringWeekday: 2,
        recurringStartTime: "18H45",
        slotsPerPlayer: 1,
        groupMinSlotsPerPlayer: 1,
        groupMaxSlotsPerPlayer: 1,
        pairCount: 1,
      },
    },
    outOfWindowSessionIds: [],
    ...overrides,
  };
}

vi.mock("../../mcp/resaSquash.js", () => ({
  reserveSlot: vi.fn(async () => ({})),
  cancelReservation: vi.fn(async () => {}),
  listGroupMembers: vi.fn(async () => ({ members: [] })),
}));

vi.mock("../../mcp/huddleBot.js", () => ({
  sendMessage: vi.fn(async () => {}),
}));

vi.mock("../../telegram/telegram.js", () => ({
  sendTelegramMessage: vi.fn(async () => {}),
}));

vi.mock("../../bookingRules.js", () => ({
  getBookingRuleById: vi.fn(async () => undefined),
}));

const {
  createAnnounceNode,
  resolveReservationNotifyJid,
  resolveAnnounceNotifyJid,
  buildVoteBookingSynthesis,
  buildNextDayReminderMessage,
} = await import("./announce.js");
const { sendMessage } = await import("../../mcp/huddleBot.js");
const { getBookingRuleById } = await import("../../bookingRules.js");
const { listGroupMembers } = await import("../../mcp/resaSquash.js");

function rule(overrides: Partial<BookingRule> = {}): BookingRule {
  return {
    id: "squashacademie-mardi",
    name: null,
    enabled: true,
    whatsappGroupJid: "group@test",
    resaSquashGroupId: "group-1",
    pollCron: "0 10 * * 2",
    decisionCron: "30 21 * * 2",
    targetWeekdayOffset: 7,
    candidateStartTimes: ["18H45"],
    maxCourtsPerSlot: 3,
    minPlayersPerCourt: 2,
    maxPlayersPerCourt: 2,
    maxReservationsPerPlayer: 2,
    priorityBookers: [],
    preferMinPlayersPerCourt: false,
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

function deps(insertedEvents: Array<Record<string, unknown>> = []): GraphDependencies {
  return {
    huddleBot: { client: {} as never, close: async () => {} },
    resaSquash: { client: {} as never, close: async () => {} },
    telegram: { botToken: "test-token", chatId: "test-chat" },
    db: {
      insert: () => ({
        values: async (row: Record<string, unknown>) => {
          insertedEvents.push(row);
        },
      }),
    } as never,
  };
}

describe("resolveReservationNotifyJid", () => {
  it("renvoie le groupe du sondage si aucune override", () => {
    expect(resolveReservationNotifyJid(rule())).toBe("group@test");
  });

  it("renvoie le groupe de notification s'il est défini", () => {
    expect(
      resolveReservationNotifyJid(rule({ reservationNotifyWhatsappGroupJid: "vincent-all@g.us" })),
    ).toBe("vincent-all@g.us");
  });
});

describe("resolveAnnounceNotifyJid", () => {
  it("préfère le destinataire live de la règle si défini après création du job", async () => {
    vi.mocked(getBookingRuleById).mockResolvedValueOnce(
      rule({ reservationNotifyWhatsappGroupJid: "vincent-all@g.us" }),
    );
    await expect(resolveAnnounceNotifyJid(deps(), rule())).resolves.toBe("vincent-all@g.us");
  });

  it("repli sur l'état graphe si la règle live est introuvable", async () => {
    vi.mocked(getBookingRuleById).mockResolvedValueOnce(undefined);
    await expect(
      resolveAnnounceNotifyJid(deps(), rule({ reservationNotifyWhatsappGroupJid: "from-state@g.us" })),
    ).resolves.toBe("from-state@g.us");
  });
});

describe("createAnnounceNode", () => {
  it("annonce les réservations proposées quand 'go' est confirmé", async () => {
    const state: PipelineStateType = {
      bookingRule: rule(),
      jobRunId: "job-1",
      targetDate: "2026-07-21",
      pollRequestId: "poll-1",
      clubClosed: false,
      confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane"] },
      volunteerSubstituteIds: [],
      bookingPlanGroups: [group()],
      goConfirmed: true,
      dryRun: true,
      announceMessage: undefined,
    };

    const node = createAnnounceNode(deps());
    const result = await node(state);

    expect(result.announceMessage).toContain("Court 4");
    expect(sendMessage).toHaveBeenCalledWith(expect.anything(), "group@test", expect.any(String));
  });

  it("envoie l'annonce vers le groupe de notification s'il est configuré", async () => {
    vi.mocked(sendMessage).mockClear();
    const state: PipelineStateType = {
      bookingRule: rule({ reservationNotifyWhatsappGroupJid: "vincent-all@g.us" }),
      jobRunId: "job-1",
      targetDate: "2026-07-21",
      pollRequestId: "poll-1",
      clubClosed: false,
      confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane"] },
      volunteerSubstituteIds: [],
      bookingPlanGroups: [group()],
      goConfirmed: true,
      dryRun: true,
      announceMessage: undefined,
    };

    await createAnnounceNode(deps())(state);

    expect(sendMessage).toHaveBeenCalledWith(expect.anything(), "vincent-all@g.us", expect.any(String));
  });

  it("n'annonce rien si 'go' n'a pas été confirmé", async () => {
    const state: PipelineStateType = {
      bookingRule: rule(),
      jobRunId: "job-1",
      targetDate: "2026-07-21",
      pollRequestId: "poll-1",
      clubClosed: false,
      confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane"] },
      volunteerSubstituteIds: [],
      bookingPlanGroups: [group()],
      goConfirmed: false,
      dryRun: true,
      announceMessage: undefined,
    };

    const node = createAnnounceNode(deps());
    const result = await node(state);

    expect(result.announceMessage).toBeUndefined();
  });

  it("exclut du message les réservations hors fenêtre (outOfWindowSessionIds)", async () => {
    const state: PipelineStateType = {
      bookingRule: rule(),
      jobRunId: "job-1",
      targetDate: "2026-07-21",
      pollRequestId: "poll-1",
      clubClosed: false,
      confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane"] },
      volunteerSubstituteIds: [],
      bookingPlanGroups: [group({ outOfWindowSessionIds: ["s1"] })],
      goConfirmed: true,
      dryRun: true,
      announceMessage: undefined,
    };

    const node = createAnnounceNode(deps());
    const result = await node(state);

    expect(result.announceMessage).toBeUndefined();
  });
});

describe("buildVoteBookingSynthesis", () => {
  it("liste les votes et les réservations effectuées", () => {
    const text = buildVoteBookingSynthesis(
      rule({ candidateStartTimes: ["18H45"] }),
      "2026-07-21",
      { "18H45": ["vincent", "stephane"] },
      [group()],
    );
    expect(text).toContain("vincent, stephane");
    expect(text).toContain("18H45");
    expect(text).toContain("court 4");
  });

  it("explique pourquoi une heure n'a rien réservé, via plan.warnings", () => {
    const emptyGroup = group({
      startTime: "19H30",
      plan: {
        dryRun: true,
        proposedBookings: [],
        warnings: ["Pas assez de joueurs confirmés à 19H30 (1/2 requis) pour proposer un créneau."],
        meta: {
          courtsNeeded: 0,
          roundsPlanned: 0,
          dryRun: true,
          groupLabel: "squashacademie-mardi",
          recurringWeekday: 2,
          recurringStartTime: "19H30",
          slotsPerPlayer: 0,
          groupMinSlotsPerPlayer: 0,
          groupMaxSlotsPerPlayer: 0,
          pairCount: 0,
        },
      },
    });
    const text = buildVoteBookingSynthesis(
      rule({ candidateStartTimes: ["19H30"] }),
      "2026-07-21",
      { "19H30": ["julie"] },
      [emptyGroup],
    );
    expect(text).toContain("Pas assez de joueurs confirmés");
  });

  it("affiche les noms des joueurs quand un mapping memberNames est fourni", () => {
    const text = buildVoteBookingSynthesis(
      rule({ candidateStartTimes: ["18H45"] }),
      "2026-07-21",
      { "18H45": ["vincent", "stephane"] },
      [group()],
      { vincent: "Vincent Lacoste", stephane: "Stéphane Martin" },
    );
    expect(text).toContain("Vincent Lacoste, Stéphane Martin");
    expect(text).toContain("Vincent Lacoste et Stéphane Martin");
    expect(text).not.toContain("vincent, stephane");
  });

  it("affiche l'userId brut quand il est absent du mapping memberNames", () => {
    const text = buildVoteBookingSynthesis(
      rule({ candidateStartTimes: ["18H45"] }),
      "2026-07-21",
      { "18H45": ["vincent", "stephane"] },
      [group()],
      { vincent: "Vincent Lacoste" },
    );
    expect(text).toContain("Vincent Lacoste et stephane");
  });

  it("liste les prête-noms volontaires (ADR-017), résolus en noms si possible", () => {
    const text = buildVoteBookingSynthesis(
      rule({ candidateStartTimes: ["18H45"] }),
      "2026-07-21",
      { "18H45": ["vincent", "stephane"] },
      [group()],
      { vincent: "Vincent Lacoste", stephane: "Stéphane Martin", julie: "Julie Durand" },
      ["julie"],
    );
    expect(text).toContain("Prête-noms volontaires :\nJulie Durand");
  });

  it("affiche '(aucun)' pour les prête-noms volontaires quand la liste est vide", () => {
    const text = buildVoteBookingSynthesis(
      rule({ candidateStartTimes: ["18H45"] }),
      "2026-07-21",
      { "18H45": ["vincent", "stephane"] },
      [group()],
    );
    expect(text).toContain("Prête-noms volontaires :\n(aucun)");
  });
});

describe("createAnnounceNode — synthèse groupe de test", () => {
  it("envoie un 2e message de synthèse quand reservationNotifyWhatsappGroupJid est configuré", async () => {
    vi.mocked(sendMessage).mockClear();
    const state: PipelineStateType = {
      bookingRule: rule({ reservationNotifyWhatsappGroupJid: "vincent-all@g.us" }),
      jobRunId: "job-1",
      targetDate: "2026-07-21",
      pollRequestId: "poll-1",
      clubClosed: false,
      confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane"] },
      volunteerSubstituteIds: ["julie"],
      bookingPlanGroups: [group()],
      goConfirmed: true,
      dryRun: true,
      announceMessage: undefined,
    };

    vi.mocked(listGroupMembers).mockResolvedValueOnce({
      members: [
        {
          group_id: "group-1",
          user_id: "vincent",
          licensee_id: "l1",
          added_at: "2026-01-01",
          role: "member",
          first_name: "Vincent",
          last_name: "Lacoste",
        },
        {
          group_id: "group-1",
          user_id: "stephane",
          licensee_id: "l2",
          added_at: "2026-01-01",
          role: "member",
          first_name: "Stéphane",
          last_name: "Martin",
        },
        {
          group_id: "group-1",
          user_id: "julie",
          licensee_id: "l3",
          added_at: "2026-01-01",
          role: "member",
          first_name: "Julie",
          last_name: "Durand",
        },
      ],
    });

    const insertedEvents: Array<Record<string, unknown>> = [];
    await createAnnounceNode(deps(insertedEvents))(state);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondCallArgs = vi.mocked(sendMessage).mock.calls[1]!;
    expect(secondCallArgs[1]).toBe("vincent-all@g.us");
    expect(secondCallArgs[2]).toContain("Vincent Lacoste, Stéphane Martin");
    expect(secondCallArgs[2]).toContain("Prête-noms volontaires :\nJulie Durand");
    expect(insertedEvents).toContainEqual(
      expect.objectContaining({ detail: { step: "synthesis-sent", notifyJid: "vincent-all@g.us" } }),
    );
  });

  it("n'envoie pas de 2e message si reservationNotifyWhatsappGroupJid n'est pas configuré", async () => {
    vi.mocked(sendMessage).mockClear();
    const state: PipelineStateType = {
      bookingRule: rule(),
      jobRunId: "job-1",
      targetDate: "2026-07-21",
      pollRequestId: "poll-1",
      clubClosed: false,
      confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane"] },
      volunteerSubstituteIds: [],
      bookingPlanGroups: [group()],
      goConfirmed: true,
      dryRun: true,
      announceMessage: undefined,
    };

    await createAnnounceNode(deps())(state);

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("n'envoie pas de 2e message si l'override a été retiré côté règle live (pas de fuite vers le groupe de prod)", async () => {
    vi.mocked(sendMessage).mockClear();
    vi.mocked(getBookingRuleById).mockResolvedValueOnce(rule({ reservationNotifyWhatsappGroupJid: null }));
    const state: PipelineStateType = {
      bookingRule: rule({ reservationNotifyWhatsappGroupJid: "vincent-all@g.us" }),
      jobRunId: "job-1",
      targetDate: "2026-07-21",
      pollRequestId: "poll-1",
      clubClosed: false,
      confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane"] },
      volunteerSubstituteIds: [],
      bookingPlanGroups: [group()],
      goConfirmed: true,
      dryRun: true,
      announceMessage: undefined,
    };

    await createAnnounceNode(deps())(state);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.anything(), "group@test", expect.any(String));
  });

  it("ne fait pas échouer le nœud si l'envoi de la synthèse (2e message) rejette", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(sendMessage).mockClear();
    vi.mocked(sendMessage)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error("synthèse KO"));
    const state: PipelineStateType = {
      bookingRule: rule({ reservationNotifyWhatsappGroupJid: "vincent-all@g.us" }),
      jobRunId: "job-1",
      targetDate: "2026-07-21",
      pollRequestId: "poll-1",
      clubClosed: false,
      confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane"] },
      volunteerSubstituteIds: [],
      bookingPlanGroups: [group()],
      goConfirmed: true,
      dryRun: true,
      announceMessage: undefined,
    };

    const insertedEvents: Array<Record<string, unknown>> = [];
    const result = await createAnnounceNode(deps(insertedEvents))(state);

    expect(result.announceMessage).toContain("Court 4");
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const firstCallArgs = vi.mocked(sendMessage).mock.calls[0]!;
    expect(firstCallArgs[1]).toBe("vincent-all@g.us");
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(insertedEvents).toContainEqual(
      expect.objectContaining({
        detail: expect.objectContaining({ step: "synthesis-failed", notifyJid: "vincent-all@g.us" }),
      }),
    );

    consoleErrorSpy.mockRestore();
  });
});

describe("buildNextDayReminderMessage", () => {
  const memberNames = {
    martin: "Martin Merlot",
    gaetan: "Gaëtan Coatanroch",
    henry: "Henry Cremniter",
    hugo: "Hugo Mercier",
    julie: "Julie Durand",
  };

  it("n'affiche pas de bloc prête-nom quand aucun n'a été utilisé", () => {
    const bookingRule = rule({
      id: "squash-samedi-matin",
      candidateStartTimes: ["10H30"],
      substituteBookers: [],
    });
    const bookingPlanGroups: BookingPlanGroup[] = [
      group({
        startTime: "10H30",
        plan: {
          dryRun: false,
          warnings: [],
          meta: group().plan.meta,
          proposedBookings: [
            {
              sessionId: "s1",
              court: 1,
              userId: "martin",
              partnerId: "gaetan",
              slotTime: "10H30",
              slotEndTime: "11H15",
              startDate: "2026-08-22T10:30:00+02:00",
            },
            {
              sessionId: "s2",
              court: 1,
              userId: "martin",
              partnerId: "gaetan",
              slotTime: "11H15",
              slotEndTime: "12H00",
              startDate: "2026-08-22T11:15:00+02:00",
            },
            {
              sessionId: "s3",
              court: 2,
              userId: "henry",
              partnerId: "hugo",
              slotTime: "10H30",
              slotEndTime: "11H15",
              startDate: "2026-08-22T10:30:00+02:00",
            },
            {
              sessionId: "s4",
              court: 2,
              userId: "henry",
              partnerId: "hugo",
              slotTime: "11H15",
              slotEndTime: "12H00",
              startDate: "2026-08-22T11:15:00+02:00",
            },
          ],
        },
      }),
    ];

    const message = buildNextDayReminderMessage(
      bookingRule,
      "2026-08-22",
      bookingPlanGroups,
      { "10H30": ["martin", "gaetan", "henry", "hugo"] },
      [],
      memberNames,
      true,
    );

    expect(message).toBe(
      "🔔 Rappel — 🏸 Réservation(s) confirmée(s) « squash-samedi-matin »\n\n" +
        "📅 2026-08-22\n\n" +
        "Court 1 : 10H30-12H00\n" +
        "Court 2 : 10H30-12H00\n\n" +
        "Votes reçus :\n" +
        "• 10H30 : Martin Merlot, Gaëtan Coatanroch, Henry Cremniter, Hugo Mercier\n\n" +
        "Le sondage WhatsApp est maintenant clôturé.",
    );
  });

  it("affiche le bloc prête-nom pour l'heure où il a été mobilisé", () => {
    const bookingRule = rule({
      id: "squash-mardi-soir",
      candidateStartTimes: ["18H45"],
      substituteBookers: [],
    });
    const bookingPlanGroups: BookingPlanGroup[] = [
      group({
        startTime: "18H45",
        plan: {
          dryRun: false,
          warnings: [],
          meta: group().plan.meta,
          proposedBookings: [
            {
              sessionId: "s1",
              court: 4,
              userId: "henry",
              partnerId: "julie",
              slotTime: "18H45",
              slotEndTime: "19H30",
              startDate: "2026-08-18T18:45:00+02:00",
            },
          ],
        },
      }),
    ];

    const message = buildNextDayReminderMessage(
      bookingRule,
      "2026-08-18",
      bookingPlanGroups,
      { "18H45": ["martin", "gaetan", "henry"] },
      ["julie"],
      memberNames,
      true,
    );

    expect(message).toBe(
      "🔔 Rappel — 🏸 Réservation(s) confirmée(s) « squash-mardi-soir »\n\n" +
        "📅 2026-08-18\n\n" +
        "Court 4 : 18H45-19H30\n\n" +
        "Votes reçus :\n" +
        "• 18H45 : Martin Merlot, Gaëtan Coatanroch, Henry Cremniter\n\n" +
        "Prête-nom(s) utilisé(s) :\n" +
        "• 18H45 : Julie Durand\n\n" +
        "Le sondage WhatsApp est maintenant clôturé.",
    );
  });
});

