import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingRule } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

const listAvailabilityMock = vi.fn();
const listMyReservationsOnDateMock = vi.fn();

vi.mock("../../mcp/resaSquash.js", () => ({
  listAvailability: (...args: unknown[]) => listAvailabilityMock(...args),
  listMyReservationsOnDate: (...args: unknown[]) => listMyReservationsOnDateMock(...args),
  listGroupMembers: vi.fn(async () => ({ members: [] })),
  lookupPlayerByPhone: vi.fn(),
}));

vi.mock("../../roster/rosterStore.js", () => ({
  listPollVoteEvents: vi.fn(async () => []),
  mergeRosterIdentities: vi.fn(async () => {}),
  saveRosterPlanSnapshot: vi.fn(async () => {}),
}));

vi.mock("../../telegram/telegram.js", () => ({
  sendTelegramMessage: vi.fn(async () => {}),
}));

vi.mock("../../jobRuns.js", () => ({
  getJobRunById: vi.fn(async () => ({ auto: false })),
}));

vi.mock("./announce.js", () => ({
  fetchGroupMemberDirectory: vi.fn(async () => ({ names: {}, unregisteredPlayerIds: new Set<string>() })),
  resolveLiveJokerBookerId: vi.fn(async () => null),
  completeNamesFromFavorites: vi.fn(async (_resa: unknown, names: Record<string, string>) => names),
}));

vi.mock("../../planning/loadPlayerPlaySlots.js", () => ({
  loadPlaySlotsConfig: vi.fn(async () => ({
    defaults: { defaultMinPlaySlots: 2, defaultMaxPlaySlots: 2 },
    overrides: new Map(),
  })),
}));

const { createBookSlotsNode } = await import("./bookSlots.js");
const { fetchGroupMemberDirectory } = await import("./announce.js");
const { getJobRunById } = await import("../../jobRuns.js");
const { sendTelegramMessage } = await import("../../telegram/telegram.js");
const { lookupPlayerByPhone } = await import("../../mcp/resaSquash.js");
const { listPollVoteEvents, mergeRosterIdentities, saveRosterPlanSnapshot } = await import("../../roster/rosterStore.js");

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
    confirmationDaysBefore: 7,
    confirmationTime: "22:30",
    candidateStartTimes: ["18H45", "19H30"],
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
    confirmationNotifyWhatsappGroupJid: null,
    cronJitterWindowMinutes: 60,
    requireTelegramGoForAutoJobs: true,
    nextDayReminderEnabled: false,
    pinMessagesEnabled: false,
    startReminderEnabled: false,
    startReminderMinutesBefore: 120,
    jokerBookerId: null,
    ...overrides,
  };
}

function deps(): GraphDependencies {
  return {
    huddleBot: { client: {} as never, close: async () => {} },
    resaSquash: { client: {} as never, close: async () => {} },
    telegram: { botToken: "test-token", chatId: "test-chat" },
    db: { insert: () => ({ values: async () => {} }) } as never,
  };
}

function baseState(bookingRule: BookingRule): PipelineStateType {
  return {
    bookingRule,
    jobRunId: "job-1",
    targetDate: "2026-07-21",
    pollRequestId: "poll-1",
    clubClosed: false,
    confirmedPlayerIdsByTime: {
      "18H45": ["vincent", "stephane", "terence"],
      "19H30": ["martin", "tin"],
    },
    volunteerSubstituteIds: ["sebastien", "mustapha"],
    unresolvedVoters: [], voterNames: {},
    bookingPlanGroups: undefined,
    goConfirmed: false,
    dryRun: true,
    announceMessage: undefined,
  reservationFailures: undefined,
  };
}

function slot(id: string, court: number, time: string, endTime: string, available = true) {
  return { id, court, time, endTime, date: "2026-07-21", participants: available ? 0 : 2, available, users: [] };
}

describe("createBookSlotsNode — moteur local", () => {
  beforeEach(() => {
    listAvailabilityMock.mockReset();
    listMyReservationsOnDateMock.mockReset();
  });

  it("scénario régression du bug rapporté 2026-07-28 : aucun conflit de court entre 18H45 et 19H30", async () => {
    listAvailabilityMock.mockResolvedValue({
      availability: [
        {
          date: "2026-07-21",
          slots: [
            slot("s1-1845", 1, "18H45", "19H30"),
            slot("s2-1845", 2, "18H45", "19H30"),
            slot("s3-1845", 3, "18H45", "19H30"),
            slot("s4-1845", 4, "18H45", "19H30"),
            slot("s1-1930", 1, "19H30", "20H15"),
            slot("s2-1930", 2, "19H30", "20H15"),
            slot("s3-1930", 3, "19H30", "20H15"),
            slot("s4-1930", 4, "19H30", "20H15"),
            slot("s1-2015", 1, "20H15", "21H00"),
            slot("s2-2015", 2, "20H15", "21H00"),
            slot("s3-2015", 3, "20H15", "21H00"),
            slot("s4-2015", 4, "20H15", "21H00"),
          ],
        },
      ],
    });
    listMyReservationsOnDateMock.mockResolvedValue({
      userId: "vincent",
      onDate: "2026-07-21",
      timeZone: "Europe/Paris",
      reservations: [], // le titulaire n'a lui-même aucun plafond — non consulté pour le quota.
    });

    const node = createBookSlotsNode(deps());
    const result = await node(baseState(rule()));
    const groups = result.bookingPlanGroups ?? [];

    expect(groups).toHaveLength(2);
    const allSessionIds = groups.flatMap((g) => g.plan.proposedBookings.map((b) => b.sessionId));
    // Aucun sessionId ne peut apparaître deux fois — le double-booking devient structurellement
    // impossible (usedSessionIds partagé entre heures candidates), pas juste détecté après coup.
    expect(new Set(allSessionIds).size).toBe(allSessionIds.length);
    expect(allSessionIds.length).toBeGreaterThan(0);
  });

  it("pas assez de joueurs confirmés : aucun appel au moteur pour cette heure, warning explicite", async () => {
    listAvailabilityMock.mockResolvedValue({ availability: [{ date: "2026-07-21", slots: [] }] });
    listMyReservationsOnDateMock.mockResolvedValue({ userId: "vincent", reservations: [] });

    const state = baseState(rule({ candidateStartTimes: ["18H45"] }));
    state.confirmedPlayerIdsByTime = { "18H45": ["solo"] };

    const node = createBookSlotsNode(deps());
    const result = await node(state);
    const group = (result.bookingPlanGroups ?? [])[0]!;

    expect(group.plan.proposedBookings).toEqual([]);
    expect(group.plan.warnings[0]).toContain("Pas assez de joueurs confirmés");
  });
});

describe("createBookSlotsNode — alerte « joueur(s) sans créneau » (joueurs, pas rounds)", () => {
  beforeEach(() => {
    listAvailabilityMock.mockReset();
    listMyReservationsOnDateMock.mockReset();
    vi.mocked(sendTelegramMessage).mockClear();
    vi.mocked(getJobRunById).mockResolvedValue({ auto: false } as never);
    vi.mocked(fetchGroupMemberDirectory).mockResolvedValue({ names: {}, unregisteredPlayerIds: new Set<string>() });
    listMyReservationsOnDateMock.mockResolvedValue({ userId: "api", reservations: [] });
  });

  function availability(slots: ReturnType<typeof slot>[]) {
    listAvailabilityMock.mockResolvedValue({ availability: [{ date: "2026-07-21", slots }] });
  }

  async function runPlan(bookingRule: BookingRule, confirmed: Record<string, string[]>) {
    const state = baseState(bookingRule);
    state.confirmedPlayerIdsByTime = confirmed;
    state.volunteerSubstituteIds = [];
    const result = await createBookSlotsNode(deps())(state);
    const message = vi.mocked(sendTelegramMessage).mock.calls[0]![1] as string;
    return { groups: result.bookingPlanGroups ?? [], message };
  }

  it("3 paires → 2 groupes de 3 complets : aucun joueur sans créneau, aucune alerte", async () => {
    availability(
      ["18H45", "19H30", "20H15"].flatMap((t, i) => {
        const end = ["19H30", "20H15", "21H00"][i]!;
        return [slot(`s1-${t}`, 1, t, end), slot(`s2-${t}`, 2, t, end)];
      }),
    );
    const { groups, message } = await runPlan(
      rule({ candidateStartTimes: ["18H45"], maxPlayersPerCourt: 3, maxDailyReservationsPerPlayer: 3 }),
      { "18H45": ["a", "b", "c", "d", "e", "f"] },
    );

    expect(groups[0]!.plan.meta.courtGroups?.map((g) => g.members.length)).toEqual([3, 3]);
    expect(groups[0]!.plan.proposedBookings).toHaveLength(6);
    expect(message).not.toContain("risquent de ne pas avoir de créneau");
  });

  it("groupe qui joue avec un round manquant : pas d'alerte (seuls les joueurs sans aucun créneau comptent)", async () => {
    availability([slot("s1-1845", 1, "18H45", "19H30")]);
    const { groups, message } = await runPlan(rule({ candidateStartTimes: ["18H45"] }), { "18H45": ["a", "b"] });

    expect(groups[0]!.plan.proposedBookings).toHaveLength(1);
    expect(message).not.toContain("risquent de ne pas avoir de créneau");
  });

  it("groupe entièrement hors fenêtre : compte ses 2 joueurs, pas ses créneaux", async () => {
    availability([
      slot("s1-1845", 1, "18H45", "19H30"),
      slot("s1-1930", 1, "19H30", "20H15"),
      slot("s2-2100", 2, "21H00", "21H45"),
      slot("s2-2145", 2, "21H45", "22H30"),
    ]);
    const { groups, message } = await runPlan(
      rule({ candidateStartTimes: ["18H45"], courtPriority: [1, 2], availabilityWindowHours: 1 }),
      { "18H45": ["a", "b", "c", "d"] },
    );

    expect(groups[0]!.outOfWindowSessionIds.sort()).toEqual(["s2-2100", "s2-2145"]);
    expect(message).toContain("⚠️ 18H45 : ~2 joueur(s) risquent de ne pas avoir de créneau");
  });
});

describe("createBookSlotsNode — résumé Telegram", () => {
  beforeEach(() => {
    listAvailabilityMock.mockReset();
    listMyReservationsOnDateMock.mockReset();
    vi.mocked(sendTelegramMessage).mockClear();
    vi.mocked(fetchGroupMemberDirectory).mockReset();
    vi.mocked(getJobRunById).mockReset();

    listAvailabilityMock.mockResolvedValue({
      availability: [
        { date: "2026-07-21", slots: [slot("s1-1845", 1, "18H45", "19H30"), slot("s1-1930", 1, "19H30", "20H15")] },
      ],
    });
    listMyReservationsOnDateMock.mockResolvedValue({ userId: "vincent", reservations: [] });
    vi.mocked(fetchGroupMemberDirectory).mockResolvedValue({
      names: { vincent: "Vincent Lacoste", stephane: "Stéphane Martin" },
      unregisteredPlayerIds: new Set<string>(),
    });
  });

  function stateForSummary(): PipelineStateType {
    const s = baseState(rule({ candidateStartTimes: ["18H45"] }));
    s.confirmedPlayerIdsByTime = { "18H45": ["vincent", "stephane"] };
    return s;
  }

  it("affiche les noms des joueurs plutôt que leur userId brut", async () => {
    vi.mocked(getJobRunById).mockResolvedValue({ auto: false } as never);

    await createBookSlotsNode(deps())(stateForSummary());

    const message = vi.mocked(sendTelegramMessage).mock.calls[0]![1] as string;
    expect(message).toContain("Vincent Lacoste et Stéphane Martin");
    expect(message).not.toContain("vincent et stephane");
  });

  it("job manuel : garde l'invite dry-run habituelle", async () => {
    vi.mocked(getJobRunById).mockResolvedValue({ auto: false } as never);

    await createBookSlotsNode(deps())(stateForSummary());

    const message = vi.mocked(sendTelegramMessage).mock.calls[0]![1] as string;
    expect(message).toContain('Réponds "go" pour confirmer (dry-run via Telegram');
  });

  it("job auto avec confirmation Telegram requise : demande le 'go'", async () => {
    vi.mocked(getJobRunById).mockResolvedValue({ auto: true } as never);

    await createBookSlotsNode(deps())(stateForSummary());

    const message = vi.mocked(sendTelegramMessage).mock.calls[0]![1] as string;
    expect(message).toContain('Réponds "go" pour confirmer — réservation RÉELLE (job automatique).');
  });

  it("job auto avec confirmation Telegram désactivée : n'invite pas à répondre 'go'", async () => {
    vi.mocked(getJobRunById).mockResolvedValue({ auto: true } as never);

    const state = stateForSummary();
    state.bookingRule = rule({ candidateStartTimes: ["18H45"], requireTelegramGoForAutoJobs: false });

    await createBookSlotsNode(deps())(state);

    const message = vi.mocked(sendTelegramMessage).mock.calls[0]![1] as string;
    expect(message).not.toContain('Réponds "go"');
    expect(message).toContain("Réservation RÉELLE en cours automatiquement");
    expect(message).toContain('confirmation "go" désactivée pour cette règle');
  });
});

describe("createBookSlotsNode — votes reçus après la collecte (roster vivant, CA-2)", () => {
  const photo = {
    capturedAt: "2026-07-14T10:00:00.000Z",
    integratedEventIds: ["e0"],
    voters: [
      { key: "tel:+331", phone: "+331", waName: "Vincent", option: "18H45", votedAt: 1000 },
      { key: "tel:+335", phone: "+335", waName: "Stéphane", option: "Non", votedAt: 1500 },
    ],
  };
  const rosterJob = {
    id: "job-1",
    auto: false,
    pollMsgId: "poll-msg",
    rosterPhoto: photo,
    rosterIdentities: { "tel:+331": { userId: "vincent", name: "Vincent" } },
  };
  // État du graphe figé à la collecte : Stéphane avait voté « Non ».
  const collectState = (bookingRule: BookingRule): PipelineStateType => ({
    ...baseState(bookingRule),
    confirmedPlayerIdsByTime: { "18H45": ["vincent"], "19H30": [] },
    volunteerSubstituteIds: [],
  });
  function voteEvent(overrides: Record<string, unknown> = {}) {
    return {
      eventId: "e1",
      eventType: "poll_vote_update",
      createdAt: new Date(3000),
      occurredAt: new Date(3000),
      actorPhone: "+335",
      actorJid: "335@s.whatsapp.net",
      actorName: "Stéphane",
      selectedOptions: ["18H45"],
      previousOptions: ["Non"],
      ...overrides,
    };
  }

  beforeEach(() => {
    listAvailabilityMock.mockReset().mockResolvedValue({
      availability: [{ date: "2026-07-21", slots: [slot("s1", 1, "18H45", "19H30"), slot("s2", 1, "19H30", "20H15")] }],
    });
    listMyReservationsOnDateMock.mockReset().mockResolvedValue({ userId: "api-user", reservations: [] });
    vi.mocked(getJobRunById).mockReset().mockResolvedValue(rosterJob as never);
    vi.mocked(listPollVoteEvents).mockReset().mockResolvedValue([voteEvent()] as never);
    vi.mocked(lookupPlayerByPhone).mockReset().mockResolvedValue({ found: true, userId: "stephane", firstName: "Stéphane" });
    vi.mocked(mergeRosterIdentities).mockClear();
    vi.mocked(saveRosterPlanSnapshot).mockReset().mockResolvedValue(undefined);
  });

  it("CA-2 : un oui arrivé après la collecte est dans confirmedPlayerIdsByTime du plan", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([voteEvent({ eventId: "e2", actorPhone: "+332", actorJid: "332@s.whatsapp.net", actorName: "Terence", previousOptions: [] })] as never);
    vi.mocked(lookupPlayerByPhone).mockResolvedValue({ found: true, userId: "terence", firstName: "Terence" });

    const update = await createBookSlotsNode(deps())(collectState(rule()));

    expect(update.confirmedPlayerIdsByTime).toEqual({ "18H45": ["vincent", "terence"], "19H30": [] });
    const group1845 = update.bookingPlanGroups!.find((g) => g.startTime === "18H45")!;
    expect(group1845.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId])).toEqual(expect.arrayContaining(["vincent", "terence"]));
  });

  it("CA-2 : un « Non » à la collecte qui revote oui est cherché (lookup) et entre dans le plan au « Calculer »", async () => {
    const update = await createBookSlotsNode(deps())(collectState(rule()));

    expect(lookupPlayerByPhone).toHaveBeenCalledTimes(1);
    expect(lookupPlayerByPhone).toHaveBeenCalledWith(expect.anything(), "+335");
    expect(update.confirmedPlayerIdsByTime).toEqual({ "18H45": ["vincent", "stephane"], "19H30": [] });
    expect(update.voterNames).toEqual({ vincent: "Vincent", stephane: "Stéphane" });
    expect(update.unresolvedVoters).toEqual([]);
    const group1845 = update.bookingPlanGroups!.find((g) => g.startTime === "18H45")!;
    expect(group1845.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId])).toEqual(expect.arrayContaining(["vincent", "stephane"]));
  });

  it("snapshot enregistré : tPlan, état et event_id intégrés", async () => {
    const tPlan = new Date("2026-07-14T19:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(tPlan);
    try {
      await createBookSlotsNode(deps())(collectState(rule()));
    } finally {
      vi.useRealTimers();
    }

    expect(saveRosterPlanSnapshot).toHaveBeenCalledWith(expect.anything(), "job-1", {
      tPlan: tPlan.toISOString(),
      state: { "tel:+331": { option: "18H45", lastAt: 1000 }, "tel:+335": { option: "18H45", lastAt: 3000 } },
      integratedEventIds: ["e0", "e1"],
    });
    expect(vi.mocked(saveRosterPlanSnapshot).mock.invocationCallOrder[0]).toBeGreaterThan(
      listAvailabilityMock.mock.invocationCallOrder[0]!,
    );
  });

  it("calcul du plan en échec : aucun snapshot enregistré", async () => {
    listAvailabilityMock.mockRejectedValue(new Error("resa down"));

    await expect(createBookSlotsNode(deps())(collectState(rule()))).rejects.toThrow("resa down");
    expect(saveRosterPlanSnapshot).not.toHaveBeenCalled();
  });

  it("job legacy : bookSlots inchangé", async () => {
    vi.mocked(getJobRunById).mockResolvedValue({ auto: false, rosterPhoto: null, pollMsgId: "poll-msg" } as never);
    const state = collectState(rule());

    const update = await createBookSlotsNode(deps())(state);

    expect(Object.keys(update)).toEqual(["bookingPlanGroups"]);
    expect(listPollVoteEvents).not.toHaveBeenCalled();
    expect(mergeRosterIdentities).not.toHaveBeenCalled();
    expect(saveRosterPlanSnapshot).not.toHaveBeenCalled();
    expect(lookupPlayerByPhone).not.toHaveBeenCalled();
  });
});
