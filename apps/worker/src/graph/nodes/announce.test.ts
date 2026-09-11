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
  listMyFavorites: vi.fn(async () => ({ favorites: [] })),
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

vi.mock("../bookingQr.js", () => ({
  sendBookingQrCodes: vi.fn(async () => 1),
}));

const {
  createAnnounceNode,
  resolveReservationNotifyJid,
  resolveAnnounceNotifyJid,
  buildVoteBookingSynthesis,
  buildNextDayReminderMessage,
  completeNamesFromFavorites,
  reserveAllForReal,
  resolveLiveJokerBookerId,
} = await import("./announce.js");
const { sendMessage } = await import("../../mcp/huddleBot.js");
const { sendTelegramMessage } = await import("../../telegram/telegram.js");
const { getBookingRuleById } = await import("../../bookingRules.js");
const { listGroupMembers, listMyFavorites, reserveSlot, cancelReservation } = await import(
  "../../mcp/resaSquash.js"
);
const { McpToolError } = await import("../../mcp/client.js");
const { sendBookingQrCodes } = await import("../bookingQr.js");

function rule(overrides: Partial<BookingRule> = {}): BookingRule {
  return {
    id: "squashacademie-mardi",
    name: null,
    enabled: true,
    whatsappGroupJid: "group@test",
    resaSquashGroupId: "group-1",
    targetWeekday: 2,
    pollDaysBefore: 7,
    pollTime: "10:00",
    decisionDaysBefore: 7,
    decisionTime: "21:30",
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
      reservationFailures: undefined,
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
      reservationFailures: undefined,
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
      reservationFailures: undefined,
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
      reservationFailures: undefined,
    };

    const node = createAnnounceNode(deps());
    const result = await node(state);

    expect(result.announceMessage).toBeUndefined();
  });

  it("réservation réelle : envoie les QR d’accès dans le groupe, après l’annonce", async () => {
    vi.mocked(sendBookingQrCodes).mockClear();
    vi.mocked(reserveSlot).mockResolvedValue({} as never);
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
      dryRun: false,
      announceMessage: undefined,
      reservationFailures: undefined,
    };

    await createAnnounceNode(deps())(state);

    expect(sendBookingQrCodes).toHaveBeenCalledWith(
      expect.anything(),
      "group@test",
      [expect.objectContaining({ sessionId: "s1", court: 4 })],
    );
  });

  it("dry-run : aucun QR envoyé (rien n’est réservé, donc rien à ouvrir)", async () => {
    vi.mocked(sendBookingQrCodes).mockClear();
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
      reservationFailures: undefined,
    };

    await createAnnounceNode(deps())(state);

    expect(sendBookingQrCodes).not.toHaveBeenCalled();
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
      reservationFailures: undefined,
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
      reservationFailures: undefined,
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
      reservationFailures: undefined,
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
      reservationFailures: undefined,
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
      reservationFailures: undefined,
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

describe("completeNamesFromFavorites", () => {
  it("complète le nom d'un joueur hors groupe (joker) via les favoris", async () => {
    vi.mocked(listMyFavorites).mockResolvedValueOnce({
      favorites: [{ userId: "joshua", firstName: "Joshua", lastName: "Kupfer" }],
    } as never);

    const names = await completeNamesFromFavorites({ client: {} } as never, { martin: "Martin Merlot" }, [
      "martin",
      "joshua",
    ]);

    expect(names).toEqual({ martin: "Martin Merlot", joshua: "Joshua Kupfer" });
  });

  it("n'appelle pas list_my_favorites quand tous les joueurs cités sont déjà connus", async () => {
    vi.mocked(listMyFavorites).mockClear();

    const names = await completeNamesFromFavorites({ client: {} } as never, { martin: "Martin Merlot" }, [
      "martin",
      null,
    ]);

    expect(listMyFavorites).not.toHaveBeenCalled();
    expect(names).toEqual({ martin: "Martin Merlot" });
  });

  it("laisse l'annuaire inchangé si les favoris sont indisponibles (best-effort)", async () => {
    vi.mocked(listMyFavorites).mockRejectedValueOnce(new Error("resa-squash KO"));

    const names = await completeNamesFromFavorites({ client: {} } as never, { martin: "Martin Merlot" }, ["joshua"]);

    expect(names).toEqual({ martin: "Martin Merlot" });
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

  it("annonce minimale : jour, courts fusionnés et votes par heure (sans nom de règle ni prête-noms)", () => {
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
      memberNames,
      true,
    );

    expect(message).toBe(
      "🔔 Rappel — Réservation pour samedi\n\n" +
        "📅 2026-08-22\n\n" +
        "Court 1 : 10H30-12H00\n" +
        "Court 2 : 10H30-12H00\n\n" +
        "• 10H30 : Martin Merlot, Gaëtan Coatanroch, Henry Cremniter, Hugo Mercier",
    );
  });

  it("n'affiche ni les prête-noms mobilisés ni la mention d'origine automatique", () => {
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
      memberNames,
      true,
    );

    expect(message).toBe(
      "🔔 Rappel — Réservation pour mardi\n\n" +
        "📅 2026-08-18\n\n" +
        "Court 4 : 18H45-19H30\n\n" +
        "• 18H45 : Martin Merlot, Gaëtan Coatanroch, Henry Cremniter",
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
    const { substitutions } = await reserveAllForReal(deps(), [booking()], JOKER);
    expect(substitutions).toEqual([]);
    expect(reserveSlot).toHaveBeenCalledTimes(1);
  });

  it("remplace le joueur désigné non réinscrit par le joker et poursuit", async () => {
    vi.mocked(reserveSlot)
      .mockRejectedValueOnce(refusal("PLAYER_NOT_REGISTERED", { players: [{ userId: "player-b" }] }))
      .mockResolvedValueOnce({} as never);

    const { substitutions } = await reserveAllForReal(deps(), [booking()], JOKER);

    expect(substitutions).toEqual([
      {
        sessionId: "s1",
        slotTime: "18H45",
        replacedUserId: "player-b",
        jokerBookerId: JOKER,
        kind: "joker",
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

    const { substitutions } = await reserveAllForReal(deps(), [booking()], JOKER);

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

    const { substitutions } = await reserveAllForReal(deps(), [booking()], JOKER);

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

    const { substitutions } = await reserveAllForReal(
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

describe("reserveAllForReal — lot partiel, fin du tout-ou-rien (2026-09-09)", () => {
  const JOKER = "joshua";
  const booking = (overrides: Record<string, unknown> = {}) => ({
    sessionId: "s1",
    court: 4,
    userId: "player-a",
    partnerId: "player-b",
    slotTime: "18H45",
    slotEndTime: "19H30",
    startDate: "2026-09-15T18:45:00+02:00",
    groupId: "group-1",
    ...overrides,
  });
  const refusal = (reason: string, details: Record<string, unknown> = {}) =>
    new McpToolError("reserve_slot", reason, details, `MCP tool "reserve_slot" a échoué : refus ${reason}`);

  beforeEach(() => {
    vi.mocked(reserveSlot).mockReset().mockResolvedValue({} as never);
    vi.mocked(cancelReservation).mockReset().mockResolvedValue(undefined as never);
  });

  it("un refus non rattrapable ne roule rien en arrière et laisse tenter les lignes suivantes", async () => {
    vi.mocked(reserveSlot)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(refusal("SLOT_ALREADY_BOOKED"))
      .mockResolvedValueOnce({} as never);

    const outcome = await reserveAllForReal(
      deps(),
      [booking(), booking({ sessionId: "s2", court: 3 }), booking({ sessionId: "s3", court: 2 })],
      null,
    );

    expect(cancelReservation).not.toHaveBeenCalled();
    expect(reserveSlot).toHaveBeenCalledTimes(3);
    expect(outcome.substitutions).toEqual([]);
    expect(outcome.failures).toEqual([
      {
        sessionId: "s2",
        court: 3,
        slotTime: "18H45",
        slotEndTime: "19H30",
        userId: "player-a",
        partnerId: "player-b",
        reason: "SLOT_ALREADY_BOOKED",
        message: expect.any(String),
        rawError: expect.stringContaining("SLOT_ALREADY_BOOKED"),
      },
    ]);
  });

  it("motif lisible : reprend le message TeamR quand resa-squash le fournit (cas réel joker noCredits, job fcd8c206)", async () => {
    vi.mocked(reserveSlot)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(
        refusal("PLAYER_BOOKING_LIMIT_REACHED", {
          teamr: { status: "noCredits", name: "Joshua J", message: "Joshua J a utilisé tous ses crédits." },
        }),
      );

    // La 2e ligne porte déjà le joker en partenaire : aucune substitution possible.
    const outcome = await reserveAllForReal(
      deps(),
      [booking(), booking({ sessionId: "s2", court: 2, userId: "player-c", partnerId: JOKER })],
      JOKER,
    );

    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({
      sessionId: "s2",
      reason: "PLAYER_BOOKING_LIMIT_REACHED",
      message: "Joshua J a utilisé tous ses crédits.",
    });
    expect(cancelReservation).not.toHaveBeenCalled();
  });

  it("motif lisible : une erreur technique (non MCP) ou sans message TeamR ne fuite jamais le texte brut aux joueurs", async () => {
    vi.mocked(reserveSlot)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error("ECONNRESET socket hang up at TCPConnectWrap"))
      .mockRejectedValueOnce(refusal("SLOT_ALREADY_BOOKED"));

    const outcome = await reserveAllForReal(
      deps(),
      [booking(), booking({ sessionId: "s2", court: 3 }), booking({ sessionId: "s3", court: 2 })],
      null,
    );

    expect(outcome.failures.map((f) => f.message)).toEqual([
      "erreur technique, contactez l'organisateur",
      "créneau déjà pris",
    ]);
    expect(outcome.failures[0]!.rawError).toContain("ECONNRESET");
    expect(outcome.failures[0]!.message).not.toContain("ECONNRESET");
  });

  it("aucune ligne réservée : l'échec reste un échec, sans annulation à faire", async () => {
    vi.mocked(reserveSlot)
      .mockRejectedValueOnce(refusal("SLOT_ALREADY_BOOKED"))
      .mockRejectedValueOnce(refusal("SLOT_ALREADY_BOOKED"));

    await expect(
      reserveAllForReal(deps(), [booking(), booking({ sessionId: "s2", court: 3 })], null),
    ).rejects.toThrow(/SLOT_ALREADY_BOOKED/);
    expect(reserveSlot).toHaveBeenCalledTimes(2);
    expect(cancelReservation).not.toHaveBeenCalled();
  });
});

describe("createAnnounceNode — réservation partielle (2026-09-09)", () => {
  const twoCourts = (): BookingPlanGroup =>
    group({
      plan: {
        ...group().plan,
        proposedBookings: [
          { ...group().plan.proposedBookings[0]! },
          { ...group().plan.proposedBookings[0]!, sessionId: "s2", court: 3, userId: "mustapha", partnerId: "stephane2" },
        ],
      },
    });
  const partialState = (): PipelineStateType => ({
    bookingRule: rule(),
    jobRunId: "job-1",
    targetDate: "2026-07-21",
    pollRequestId: "poll-1",
    clubClosed: false,
    confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane", "mustapha", "stephane2"] },
    volunteerSubstituteIds: [],
    bookingPlanGroups: [twoCourts()],
    goConfirmed: true,
    dryRun: false,
    announceMessage: undefined,
      reservationFailures: undefined,
  });

  beforeEach(() => {
    vi.mocked(sendMessage).mockClear();
    vi.mocked(sendTelegramMessage).mockClear();
    vi.mocked(sendBookingQrCodes).mockClear();
    vi.mocked(cancelReservation).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(reserveSlot)
      .mockReset()
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(
        new McpToolError(
          "reserve_slot",
          "PLAYER_BOOKING_LIMIT_REACHED",
          { teamr: { status: "noCredits", message: "Joshua J a utilisé tous ses crédits." } },
          'MCP tool "reserve_slot" a échoué : PLAYER_BOOKING_LIMIT_REACHED (noCredits)',
        ),
      );
  });

  it("garde les résas prises et annonce sur WhatsApp les courts pris + les non réservés avec le motif", async () => {
    const result = await createAnnounceNode(deps())(partialState());

    expect(cancelReservation).not.toHaveBeenCalled();
    const announce = vi.mocked(sendMessage).mock.calls.find((c) => String(c[2]).includes("Réservation(s) confirmée(s)"));
    expect(announce).toBeDefined();
    const text = String(announce![2]);
    expect(text).toContain("Court 4 : 18H45-19H30");
    expect(text).not.toContain("Court 3 : 18H45-19H30");
    expect(text).toContain("Non réservé");
    expect(text).toContain("18H45-19H30 (court 3)");
    expect(text).toContain("Joshua J a utilisé tous ses crédits.");
    expect(text).not.toContain("échec de la réservation automatique");
    expect(result.announceMessage).toBe(text);
    expect(result.reservationFailures).toEqual([expect.objectContaining({ sessionId: "s2", court: 3 })]);
  });

  it("logue les refus dans l'événement « announced » et les détaille sur Telegram", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    await createAnnounceNode(deps(inserted))(partialState());

    const announced = inserted.find((e) => (e.detail as { step?: string }).step === "announced");
    expect(announced).toBeDefined();
    expect((announced!.detail as { reservationFailures?: unknown[] }).reservationFailures).toEqual([
      expect.objectContaining({ sessionId: "s2", reason: "PLAYER_BOOKING_LIMIT_REACHED" }),
    ]);
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/Annonce envoyée[\s\S]*Non réservé[\s\S]*18H45-19H30 \(court 3\)[\s\S]*PLAYER_BOOKING_LIMIT_REACHED/),
    );
  });

  it("n'envoie le QR d'accès que pour les courts réellement réservés", async () => {
    await createAnnounceNode(deps())(partialState());

    expect(sendBookingQrCodes).toHaveBeenCalledWith(expect.anything(), "group@test", [
      expect.objectContaining({ sessionId: "s1", court: 4 }),
    ]);
  });
});

describe("messages dérivés — ignorent les lignes non réservées (2026-09-09)", () => {
  const failure = {
    sessionId: "s2",
    court: 3,
    slotTime: "18H45",
    slotEndTime: "19H30",
    userId: "mustapha",
    partnerId: "stephane2",
    reason: "PLAYER_BOOKING_LIMIT_REACHED",
    message: "Joshua J a utilisé tous ses crédits.",
    rawError: "raw",
  };
  const twoCourts = (): BookingPlanGroup =>
    group({
      plan: {
        ...group().plan,
        proposedBookings: [
          { ...group().plan.proposedBookings[0]! },
          { ...group().plan.proposedBookings[0]!, sessionId: "s2", court: 3, userId: "mustapha", partnerId: "stephane2" },
        ],
      },
    });

  it("rappel J+1 : seuls les courts réellement réservés", () => {
    const text = buildNextDayReminderMessage(rule(), "2026-07-21", [twoCourts()], {}, {}, true, [failure]);
    expect(text).toContain("Court 4 : 18H45-19H30");
    expect(text).not.toContain("Court 3");
  });

  it("synthèse : marque la ligne non réservée avec son motif", () => {
    const text = buildVoteBookingSynthesis(rule(), "2026-07-21", { "18H45": ["vincent"] }, [twoCourts()], {}, [], [failure]);
    expect(text).toMatch(/court 3\).*non réservé.*Joshua J a utilisé tous ses crédits\./);
  });
});

describe("reserveAllForReal — cascade prête-noms puis joker à la réservation (2026-09-09)", () => {
  const JOKER = "joshua";
  const booking = (overrides: Record<string, unknown> = {}) => ({
    sessionId: "s1",
    court: 2,
    userId: "martin",
    partnerId: JOKER,
    slotTime: "19H30",
    slotEndTime: "20H15",
    startDate: "2026-09-15T19:30:00+02:00",
    groupId: "group-1",
    ...overrides,
  });
  const refusal = (reason: string, details: Record<string, unknown> = {}) =>
    new McpToolError("reserve_slot", reason, details, `MCP tool "reserve_slot" a échoué : refus ${reason}`);

  beforeEach(() => {
    vi.mocked(reserveSlot).mockReset().mockResolvedValue({} as never);
    vi.mocked(cancelReservation).mockReset().mockResolvedValue(undefined as never);
  });

  it("joker à sec : la ligne est reprise par le premier prête-nom disponible (cas réel job fcd8c206)", async () => {
    vi.mocked(reserveSlot)
      .mockRejectedValueOnce(refusal("PLAYER_BOOKING_LIMIT_REACHED", { teamr: { message: "Joshua a utilisé tous ses crédits." } }))
      .mockResolvedValueOnce({} as never);

    const outcome = await reserveAllForReal(deps(), [booking()], JOKER, {
      substituteIds: ["sub-1", "sub-2"],
      maxDailyReservationsPerPlayer: 2,
    });

    expect(outcome.failures).toEqual([]);
    expect(vi.mocked(reserveSlot).mock.calls[1]![1]).toMatchObject({ userId: "martin", partnerId: "sub-1" });
    expect(outcome.substitutions).toEqual([
      { sessionId: "s1", slotTime: "19H30", replacedUserId: JOKER, jokerBookerId: "sub-1", kind: "substitute", reason: "PLAYER_BOOKING_LIMIT_REACHED" },
    ]);
  });

  it("un prête-nom lui-même refusé par TeamR passe la main au suivant, puis au joker", async () => {
    vi.mocked(reserveSlot)
      .mockRejectedValueOnce(refusal("PLAYER_NOT_REGISTERED", { players: [{ userId: "player-b" }] }))
      .mockRejectedValueOnce(refusal("PLAYER_NOT_REGISTERED", { players: [{ userId: "sub-1" }] }))
      .mockResolvedValueOnce({} as never);

    const outcome = await reserveAllForReal(deps(), [booking({ userId: "player-a", partnerId: "player-b" })], JOKER, {
      substituteIds: ["sub-1"],
      maxDailyReservationsPerPlayer: 2,
    });

    expect(reserveSlot).toHaveBeenCalledTimes(3);
    expect(vi.mocked(reserveSlot).mock.calls[2]![1]).toMatchObject({ userId: "player-a", partnerId: JOKER });
    expect(outcome.substitutions[0]).toMatchObject({ replacedUserId: "player-b", jokerBookerId: JOKER, kind: "joker" });
  });

  it("un prête-nom au plafond du jour (lignes du plan + substitutions déjà faites) est sauté", async () => {
    // sub-1 porte déjà 2 lignes du plan ce jour → plafond 2 atteint → sub-2 est pris.
    vi.mocked(reserveSlot)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(refusal("PLAYER_BOOKING_LIMIT_REACHED"))
      .mockResolvedValueOnce({} as never);

    const outcome = await reserveAllForReal(
      deps(),
      [
        booking({ sessionId: "p1", court: 4, slotTime: "18H45", userId: "x", partnerId: "sub-1" }),
        booking({ sessionId: "p2", court: 4, slotTime: "19H30", userId: "x", partnerId: "sub-1" }),
        booking(),
      ],
      JOKER,
      { substituteIds: ["sub-1", "sub-2"], maxDailyReservationsPerPlayer: 2 },
    );

    expect(outcome.failures).toEqual([]);
    expect(vi.mocked(reserveSlot).mock.calls[3]![1]).toMatchObject({ userId: "martin", partnerId: "sub-2" });
  });
});

describe("createAnnounceNode — file de prête-noms à la réservation (2026-09-09)", () => {
  it("construit la file depuis les volontaires du sondage puis les prête-noms de la règle, et le signale sur Telegram", async () => {
    vi.mocked(sendTelegramMessage).mockClear();
    vi.mocked(reserveSlot)
      .mockReset()
      .mockRejectedValueOnce(
        new McpToolError("reserve_slot", "PLAYER_BOOKING_LIMIT_REACHED", {}, 'MCP tool "reserve_slot" a échoué : noCredits'),
      )
      .mockResolvedValueOnce({} as never);
    const state: PipelineStateType = {
      bookingRule: rule({ substituteBookers: ["rule-sub"] }),
      jobRunId: "job-1",
      targetDate: "2026-07-21",
      pollRequestId: "poll-1",
      clubClosed: false,
      confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane"] },
      volunteerSubstituteIds: ["volunteer"],
      bookingPlanGroups: [group()],
      goConfirmed: true,
      dryRun: false,
      announceMessage: undefined,
      reservationFailures: undefined,
    };

    const result = await createAnnounceNode(deps())(state);

    expect(result.reservationFailures).toEqual([]);
    // Le volontaire passe avant le prête-nom de la règle.
    expect(vi.mocked(reserveSlot).mock.calls[1]![1]).toMatchObject({ userId: "vincent", partnerId: "volunteer" });
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/prête-nom[\s\S]*volunteer/),
    );
  });
});
