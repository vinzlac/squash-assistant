import { describe, expect, it, vi } from "vitest";
import type { BookingRule } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../dependencies.js";
import type { BookingPlanGroup, PipelineStateType } from "../state.js";

vi.mock("../../mcp/resaSquash.js", () => ({
  reserveSlot: vi.fn(async () => ({})),
  cancelReservation: vi.fn(async () => {}),
}));

vi.mock("../../mcp/huddleBot.js", () => ({
  sendMessage: vi.fn(async () => {}),
}));

vi.mock("../../telegram/telegram.js", () => ({
  sendTelegramMessage: vi.fn(async () => {}),
}));

const { createAnnounceNode } = await import("./announce.js");

function rule(): BookingRule {
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

/**
 * Reproduit un BookingPlanGroup tel que persisté (checkpoint Redis) par une
 * exécution de BookSlots *avant* l'ajout du champ conflictingSessionIds (bug
 * rapporté 2026-07-28 : `Cannot read properties of undefined (reading 'includes')`
 * au reload de la page d'un job dont le plan avait été calculé avant le déploiement
 * du correctif de conflit de court). `as BookingPlanGroup` simule la désérialisation
 * d'un ancien état, où le champ est simplement absent — pas juste `undefined` en JS.
 */
function legacyGroupWithoutConflictField(): BookingPlanGroup {
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
  } as BookingPlanGroup;
}

describe("createAnnounceNode — compatibilité avec un plan persisté avant l'ajout de conflictingSessionIds", () => {
  it("n'explose pas et annonce normalement un plan dont conflictingSessionIds est absent", async () => {
    const state: PipelineStateType = {
      bookingRule: rule(),
      jobRunId: "job-1",
      targetDate: "2026-07-21",
      pollRequestId: "poll-1",
      confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane"] },
      volunteerSubstituteIds: [],
      bookingPlanGroups: [legacyGroupWithoutConflictField()],
      goConfirmed: true,
      dryRun: true,
      announceMessage: undefined,
    };

    const node = createAnnounceNode(deps());
    const result = await node(state);

    expect(result.announceMessage).toContain("Court 4");
  });
});
