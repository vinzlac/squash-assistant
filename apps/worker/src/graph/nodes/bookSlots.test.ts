import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingRule } from "@squash-assistant/db/schema";
import type { PlanGroupBookingsParams, GroupBookingPlan } from "../../mcp/resaSquash.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

const planGroupBookingsMock = vi.fn<(client: unknown, params: PlanGroupBookingsParams) => Promise<GroupBookingPlan>>();

vi.mock("../../mcp/resaSquash.js", () => ({
  planGroupBookings: (client: unknown, params: PlanGroupBookingsParams) => planGroupBookingsMock(client, params),
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
      "18H45": ["vincent", "stephane", "terence", "sebastien"],
      "19H30": ["martin", "tin"],
    },
    volunteerSubstituteIds: [],
    bookingPlanGroups: undefined,
    goConfirmed: false,
    dryRun: true,
    announceMessage: undefined,
  };
}

function planFor18h45(): GroupBookingPlan {
  return {
    dryRun: true,
    proposedBookings: [
      {
        sessionId: "s-1845-c4-r1",
        court: 4,
        userId: "vincent",
        partnerId: "stephane",
        slotTime: "18H45",
        slotEndTime: "19H30",
      },
      {
        sessionId: "s-1845-c4-r2",
        court: 4,
        userId: "vincent",
        partnerId: "stephane",
        slotTime: "19H30",
        slotEndTime: "20H15",
      },
      {
        sessionId: "s-1845-c3-r1",
        court: 3,
        userId: "terence",
        partnerId: "sebastien",
        slotTime: "18H45",
        slotEndTime: "19H30",
      },
      {
        sessionId: "s-1845-c3-r2",
        court: 3,
        userId: "terence",
        partnerId: "sebastien",
        slotTime: "19H30",
        slotEndTime: "20H15",
      },
    ],
    warnings: [],
    meta: {
      courtsNeeded: 2,
      roundsPlanned: 2,
      dryRun: true,
      groupLabel: "squashacademie-mardi",
      recurringWeekday: 2,
      recurringStartTime: "18H45",
      slotsPerPlayer: 2,
      groupMinSlotsPerPlayer: 2,
      groupMaxSlotsPerPlayer: 2,
      pairCount: 2,
    },
  };
}

/** Simule resa-squash retenant systématiquement le 1er court de `courtPriority` — comme un vrai algorithme d'allocation qui suit l'ordre de préférence transmis. */
function planFor19h30HonoringPriority(params: PlanGroupBookingsParams): GroupBookingPlan {
  const chosenCourt = params.courtPriority?.[0] ?? 4;
  return {
    dryRun: true,
    proposedBookings: [
      {
        sessionId: "s-1930-r1",
        court: chosenCourt,
        userId: "martin",
        partnerId: "tin",
        slotTime: "19H30",
        slotEndTime: "20H15",
      },
      {
        sessionId: "s-1930-r2",
        court: chosenCourt,
        userId: "martin",
        partnerId: "tin",
        slotTime: "20H15",
        slotEndTime: "21H00",
      },
    ],
    warnings: [],
    meta: {
      courtsNeeded: 1,
      roundsPlanned: 2,
      dryRun: true,
      groupLabel: "squashacademie-mardi",
      recurringWeekday: 2,
      recurringStartTime: "19H30",
      slotsPerPlayer: 2,
      groupMinSlotsPerPlayer: 2,
      groupMaxSlotsPerPlayer: 2,
      pairCount: 1,
    },
  };
}

/** Simule resa-squash ignorant `courtPriority` et retenant toujours le court 4 — cas où aucun autre court n'est réellement libre. */
function planFor19h30AlwaysCourt4(): GroupBookingPlan {
  return {
    dryRun: true,
    proposedBookings: [
      {
        sessionId: "s-1930-r1",
        court: 4,
        userId: "martin",
        partnerId: "tin",
        slotTime: "19H30",
        slotEndTime: "20H15",
      },
      {
        sessionId: "s-1930-r2",
        court: 4,
        userId: "martin",
        partnerId: "tin",
        slotTime: "20H15",
        slotEndTime: "21H00",
      },
    ],
    warnings: [],
    meta: {
      courtsNeeded: 1,
      roundsPlanned: 2,
      dryRun: true,
      groupLabel: "squashacademie-mardi",
      recurringWeekday: 2,
      recurringStartTime: "19H30",
      slotsPerPlayer: 2,
      groupMinSlotsPerPlayer: 2,
      groupMaxSlotsPerPlayer: 2,
      pairCount: 1,
    },
  };
}

describe("createBookSlotsNode — conflit de court entre deux heures candidates (bug rapporté 2026-07-28)", () => {
  beforeEach(() => {
    planGroupBookingsMock.mockReset();
  });

  it("déprioritise le court 4 (déjà pris 18H45→20H15) pour l'appel 19H30, évitant le double-booking", async () => {
    planGroupBookingsMock.mockImplementation(async (_client, params) =>
      params.startTime === "18H45" ? planFor18h45() : planFor19h30HonoringPriority(params),
    );

    const node = createBookSlotsNode(deps());
    const result = await node(baseState(rule()));
    const groups = result.bookingPlanGroups ?? [];

    expect(groups).toHaveLength(2);
    const group1930 = groups.find((g) => g.startTime === "19H30");
    expect(group1930).toBeDefined();
    // Les courts 3 et 4 sont tous les deux occupés par le groupe 18H45 sur 19H30-20H15
    // → tous les deux déprioritisés, le 2e appel doit obtenir un court totalement libre (2).
    expect(group1930?.plan.proposedBookings.every((b) => b.court === 2)).toBe(true);
    expect(group1930?.conflictingSessionIds).toEqual([]);

    const secondCallParams = planGroupBookingsMock.mock.calls[1]?.[1] as PlanGroupBookingsParams;
    expect(secondCallParams.startTime).toBe("19H30");
    // 4 et 3 toujours proposés (en dernier recours) mais plus en tête de liste.
    expect(secondCallParams.courtPriority).toEqual([2, 1, 4, 3]);
  });

  it("écarte et signale comme conflit une réservation qui chevauche quand même un court déjà pris (resa-squash n'a pas d'autre court libre)", async () => {
    planGroupBookingsMock.mockImplementation(async (_client, params) =>
      params.startTime === "18H45" ? planFor18h45() : planFor19h30AlwaysCourt4(),
    );

    const node = createBookSlotsNode(deps());
    const result = await node(baseState(rule()));
    const groups = result.bookingPlanGroups ?? [];

    const group1930 = groups.find((g) => g.startTime === "19H30");
    expect(group1930).toBeDefined();
    // 19H30-20H15 sur le court 4 chevauche le round 2 du groupe 18H45 (aussi 19H30-20H15,
    // court 4) → doit être détecté comme conflit et jamais réservé.
    expect(group1930?.conflictingSessionIds).toEqual(["s-1930-r1"]);
    // Le round suivant (20H15-21H00) ne chevauche plus rien : pas de conflit.
    expect(group1930?.plan.proposedBookings.find((b) => b.sessionId === "s-1930-r2")).toBeDefined();
  });
});
