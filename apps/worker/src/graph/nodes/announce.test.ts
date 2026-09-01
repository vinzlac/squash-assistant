import { beforeEach, describe, expect, it, vi } from "vitest";
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
  reserveAllForReal,
  resolveLiveJokerBookerId,
} = await import("./announce.js");
const { sendMessage } = await import("../../mcp/huddleBot.js");
const { getBookingRuleById } = await import("../../bookingRules.js");
const { listGroupMembers, reserveSlot, cancelReservation } = await import("../../mcp/resaSquash.js");
const { McpToolError } = await import("../../mcp/client.js");

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
    jokerBookerId: null,
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

  it("bugfix 2026-08-26 : réservation réelle en échec (ex. reserve_slot rejeté par TeamR, noCredits) — prévient le groupe WhatsApp au lieu du silence total, et propage l'erreur", async () => {
    vi.mocked(sendMessage).mockClear();
    vi.mocked(reserveSlot).mockRejectedValueOnce(
      new Error(
        'MCP tool "reserve_slot" a échoué : [{"type":"text","text":"Vincent LACOSTE a utilisé tous ses crédits. Vous avez le droit à deux réservations de 1 à 7 jours à l\'avance. (noCredits)"}]',
      ),
    );
    const insertedEvents: Array<Record<string, unknown>> = [];
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
      dryRun: false, // dryRun === false → réservation réelle (reserveAllForReal).
      announceMessage: undefined,
    };

    const node = createAnnounceNode(deps(insertedEvents));
    await expect(node(state)).rejects.toThrow("noCredits");

    // Message WhatsApp générique envoyé au groupe — pas le texte brut de l'erreur (réservé à
    // Telegram/DB), mais un signal clair qu'aucun court n'a été réservé.
    expect(sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "group@test",
      expect.stringContaining("échec de la réservation automatique"),
    );
    // L'annonce normale (avec les créneaux) n'a jamais été envoyée.
    expect(sendMessage).not.toHaveBeenCalledWith(expect.anything(), "group@test", expect.stringContaining("Court 4"));
    // L'événement d'erreur logué en DB garde le texte brut (pour l'UI/Telegram, cf. Pipeline.tsx).
    expect(insertedEvents.some((e) => e.status === "error" && String((e.detail as { error?: string }).error).includes("noCredits"))).toBe(
      true,
    );
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
        "🤖 Réservation effectuée automatiquement par squash-assistant.\n\n" +
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
        "🤖 Réservation effectuée automatiquement par squash-assistant.\n\n" +
        "Le sondage WhatsApp est maintenant clôturé.",
    );
  });
});


describe("reserveAllForReal — joker (ADR-024)", () => {
  const JOKER = "joshua";
  const booking = (overrides: Record<string, unknown> = {}) => ({
    sessionId: "s1",
    court: 1,
    userId: "player-a",
    partnerId: "player-b",
    slotTime: "18H45",
    slotEndTime: "19H30",
    startDate: "2026-09-12T18:45:00+02:00",
    groupId: "group-1",
    ...overrides,
  });

  function refusal(reason: string, details: Record<string, unknown> = {}) {
    return new McpToolError("reserve_slot", reason, details, `refus ${reason}`);
  }

  beforeEach(() => {
    vi.mocked(reserveSlot).mockReset();
    vi.mocked(cancelReservation).mockReset();
    vi.mocked(reserveSlot).mockResolvedValue({} as never);
    vi.mocked(cancelReservation).mockResolvedValue(undefined as never);
  });

  it("réserve sans substitution quand tout passe", async () => {
    const substitutions = await reserveAllForReal(deps(), [booking()], JOKER);
    expect(substitutions).toEqual([]);
    expect(reserveSlot).toHaveBeenCalledTimes(1);
  });

  it("remplace le joueur désigné non réinscrit par le joker et poursuit", async () => {
    vi.mocked(reserveSlot)
      .mockRejectedValueOnce(refusal("PLAYER_NOT_REGISTERED", { players: [{ userId: "player-b" }] }))
      .mockResolvedValueOnce({} as never);

    const substitutions = await reserveAllForReal(deps(), [booking()], JOKER);

    expect(substitutions).toEqual([
      {
        sessionId: "s1",
        slotTime: "18H45",
        replacedUserId: "player-b",
        jokerBookerId: JOKER,
        reason: "PLAYER_NOT_REGISTERED",
      },
    ]);
    expect(vi.mocked(reserveSlot).mock.calls[1]![1]).toMatchObject({
      userId: "player-a",
      partnerId: JOKER,
    });
    expect(cancelReservation).not.toHaveBeenCalled();
  });

  it("titulaire refusé : promeut le partenaire titulaire et met le joker en partenaire", async () => {
    vi.mocked(reserveSlot)
      .mockRejectedValueOnce(refusal("PLAYER_NOT_REGISTERED", { players: [{ userId: "player-a" }] }))
      .mockResolvedValueOnce({} as never);

    const substitutions = await reserveAllForReal(deps(), [booking()], JOKER);

    expect(substitutions[0]).toMatchObject({ replacedUserId: "player-a" });
    expect(vi.mocked(reserveSlot).mock.calls[1]![1]).toMatchObject({
      userId: "player-b",
      partnerId: JOKER,
    });
  });

  it("quota TeamR sans joueur désigné : tente le partenaire puis la promotion", async () => {
    vi.mocked(reserveSlot)
      .mockRejectedValueOnce(refusal("PLAYER_BOOKING_LIMIT_REACHED"))
      .mockRejectedValueOnce(refusal("PLAYER_BOOKING_LIMIT_REACHED"))
      .mockResolvedValueOnce({} as never);

    const substitutions = await reserveAllForReal(deps(), [booking()], JOKER);

    expect(substitutions[0]).toMatchObject({ replacedUserId: "player-a" });
    expect(vi.mocked(reserveSlot).mock.calls[2]![1]).toMatchObject({
      userId: "player-b",
      partnerId: JOKER,
    });
  });

  it("réutilise le joker plusieurs fois au même horaire (sans limite en partenaire)", async () => {
    vi.mocked(reserveSlot)
      .mockRejectedValueOnce(refusal("PLAYER_NOT_REGISTERED", { players: [{ userId: "player-b" }] }))
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(refusal("PLAYER_NOT_REGISTERED", { players: [{ userId: "player-d" }] }))
      .mockResolvedValueOnce({} as never);

    const substitutions = await reserveAllForReal(
      deps(),
      [booking(), booking({ sessionId: "s2", court: 2, userId: "player-c", partnerId: "player-d" })],
      JOKER,
    );

    expect(substitutions.map((sub) => sub.replacedUserId)).toEqual(["player-b", "player-d"]);
    // Deux réservations au même horaire portent le joker en partenaire : aucun rollback.
    expect(cancelReservation).not.toHaveBeenCalled();
  });

  it("les deux joueurs refusés : aucun titulaire valide, échec du lot", async () => {
    vi.mocked(reserveSlot).mockRejectedValueOnce(
      refusal("PLAYER_NOT_REGISTERED", { players: [{ userId: "player-a" }, { userId: "player-b" }] }),
    );

    await expect(reserveAllForReal(deps(), [booking()], JOKER)).rejects.toThrow(/PLAYER_NOT_REGISTERED/);
    expect(reserveSlot).toHaveBeenCalledTimes(1);
  });

  it("ne substitue pas sur un refus d'une autre nature", async () => {
    vi.mocked(reserveSlot).mockRejectedValueOnce(refusal("SLOT_ALREADY_BOOKED"));

    await expect(reserveAllForReal(deps(), [booking()], JOKER)).rejects.toThrow(/SLOT_ALREADY_BOOKED/);
    expect(reserveSlot).toHaveBeenCalledTimes(1);
  });

  it("sans joker configuré : comportement historique, l'échec reste un échec", async () => {
    vi.mocked(reserveSlot).mockRejectedValueOnce(refusal("PLAYER_NOT_REGISTERED", { players: [{ userId: "player-b" }] }));

    await expect(reserveAllForReal(deps(), [booking()], null)).rejects.toThrow(/PLAYER_NOT_REGISTERED/);
    expect(reserveSlot).toHaveBeenCalledTimes(1);
  });
});

describe("resolveLiveJokerBookerId — joker relu sur la règle live (ADR-024)", () => {
  beforeEach(() => {
    vi.mocked(getBookingRuleById).mockReset();
  });

  it("prend le joker de la règle live, pas celui figé au lancement du sondage", async () => {
    // Cas réel du 2026-09-01 : sondage envoyé avant que le joker soit configuré → l'état du
    // graphe portait jokerBookerId=null et la substitution était ignorée toute la semaine.
    vi.mocked(getBookingRuleById).mockResolvedValueOnce(rule({ jokerBookerId: "joshua" }));

    expect(await resolveLiveJokerBookerId(deps(), rule({ jokerBookerId: null }))).toBe("joshua");
  });

  it("un joker retiré depuis la création du job est bien retiré (null live fait foi)", async () => {
    vi.mocked(getBookingRuleById).mockResolvedValueOnce(rule({ jokerBookerId: null }));

    expect(await resolveLiveJokerBookerId(deps(), rule({ jokerBookerId: "joshua" }))).toBeNull();
  });

  it("règle live introuvable : repli sur la valeur figée dans l'état", async () => {
    vi.mocked(getBookingRuleById).mockResolvedValueOnce(undefined);

    expect(await resolveLiveJokerBookerId(deps(), rule({ jokerBookerId: "joshua" }))).toBe("joshua");
  });

  it("erreur de lecture DB : repli sur la valeur figée, jamais d'échec du nœud", async () => {
    vi.mocked(getBookingRuleById).mockRejectedValueOnce(new Error("db down"));

    expect(await resolveLiveJokerBookerId(deps(), rule({ jokerBookerId: "joshua" }))).toBe("joshua");
  });
});
