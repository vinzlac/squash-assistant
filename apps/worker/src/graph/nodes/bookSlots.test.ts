import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingRule } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

const listAvailabilityMock = vi.fn();
const listMyReservationsOnDateMock = vi.fn();

vi.mock("../../mcp/resaSquash.js", () => ({
  listAvailability: (...args: unknown[]) => listAvailabilityMock(...args),
  listMyReservationsOnDate: (...args: unknown[]) => listMyReservationsOnDateMock(...args),
}));

vi.mock("../../telegram/telegram.js", () => ({
  sendTelegramMessage: vi.fn(async () => {}),
}));

const { createBookSlotsNode } = await import("./bookSlots.js");

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
    confirmedPlayerIdsByTime: {
      "18H45": ["vincent", "stephane", "terence"],
      "19H30": ["martin", "tin"],
    },
    volunteerSubstituteIds: ["sebastien", "mustapha"],
    bookingPlanGroups: undefined,
    goConfirmed: false,
    dryRun: true,
    announceMessage: undefined,
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
