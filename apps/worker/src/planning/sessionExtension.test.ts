// apps/worker/src/planning/sessionExtension.test.ts
import { describe, expect, it } from "vitest";
import {
  buildOngoingSessionsFromPlan,
  extendSessionForLateJoiners,
  findMergeableSession,
  type OngoingSession,
} from "./sessionExtension.js";
import type { AvailableSlot } from "./courtAssignment.js";
import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import { DEFAULT_PLAY_SLOTS } from "./playerPlaySlots.js";

function makeSlots(courts: number[], beginTime: string, endTime: string): AvailableSlot[] {
  return courts.map((court) => ({ sessionId: `s-${court}-${beginTime}`, court, beginTime, endTime }));
}

function basePlan(bookings: GroupBookingPlan["proposedBookings"]): GroupBookingPlan {
  return {
    dryRun: true,
    proposedBookings: bookings,
    warnings: [],
    meta: {
      courtsNeeded: 1,
      roundsPlanned: bookings.length,
      dryRun: true,
      groupLabel: "g1",
      recurringWeekday: 2,
      recurringStartTime: "10H30",
      slotsPerPlayer: 2,
      groupMinSlotsPerPlayer: 2,
      groupMaxSlotsPerPlayer: 2,
      pairCount: 1,
    },
  };
}

describe("buildOngoingSessionsFromPlan", () => {
  it("extrait members (joueurs confirmés réels, pas les prête-noms) et roundsNeeded par court", () => {
    const plan = basePlan([
      {
        sessionId: "s1",
        userId: "a",
        partnerId: "sub-1",
        startDate: "2026-08-04T10:30:00+02:00",
        court: 3,
        slotTime: "10H30",
        slotEndTime: "11H15",
        groupId: "g1",
      },
    ]);
    const sessions = buildOngoingSessionsFromPlan(plan, "10H30", 0, ["a"], DEFAULT_PLAY_SLOTS, new Map());
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.members).toEqual(["a"]);
    expect(sessions[0]!.roundsBooked).toBe(1);
    expect(sessions[0]!.roundsNeeded).toBe(2);
  });

  it("plan vide → aucune session", () => {
    expect(buildOngoingSessionsFromPlan(basePlan([]), "10H30", 0, ["a"], DEFAULT_PLAY_SLOTS, new Map())).toEqual([]);
  });
});

describe("extendSessionForLateJoiners", () => {
  it("ajoute un late joiner et prolonge jusqu'à ce que le groupe atteigne roundsNeeded (3 pour un trio par défaut)", () => {
    const availableSlots = [
      ...makeSlots([1], "10H30", "11H15"),
      ...makeSlots([1], "11H15", "12H00"),
      ...makeSlots([1], "12H00", "12H45"),
    ];
    const session: OngoingSession = {
      court: 1,
      anchorStartTime: "10H30",
      members: ["a", "b"],
      roundsBooked: 2,
      roundsNeeded: 2,
      proposedBookings: [
        {
          sessionId: "s-1-10H30",
          userId: "a",
          partnerId: "b",
          startDate: "2026-08-04T10:30:00+02:00",
          court: 1,
          slotTime: "10H30",
          slotEndTime: "11H15",
          groupId: "g1",
        },
        {
          sessionId: "s-1-11H15",
          userId: "a",
          partnerId: "b",
          startDate: "2026-08-04T11:15:00+02:00",
          court: 1,
          slotTime: "11H15",
          slotEndTime: "12H00",
          groupId: "g1",
        },
      ],
      groupIndex: 0,
    };
    const usedSessionIds = new Set(["s-1-10H30", "s-1-11H15"]);
    const warnings: string[] = [];

    const extra = extendSessionForLateJoiners({
      session,
      lateJoinerIds: ["c"],
      joinTime: "10H30",
      targetDate: "2026-08-04",
      groupId: "g1",
      maxPlayersPerCourt: 3,
      // 3 et non 2 : le round étendu nomme le membre le moins souvent nommé ("c", 0 apparition)
      // et le suivant par ordre de members à égalité ("a", 2 apparitions comme "b") — cf.
      // sélection adaptative par compte d'apparitions (extendSessionForLateJoiners). Avec un
      // plafond de 2, "a" (déjà nommé 2 fois) dépasserait le plafond TeamR et forcerait un
      // prête-nom (substituteQueue vide ici), ce qui contredit l'assertion userId/partnerId
      // ci-dessous.
      maxDailyReservationsPerPlayer: 3,
      availabilityWindowHours: 3,
      availableSlots,
      usedSessionIds,
      substituteQueue: [],
      existingDailyCounts: {},
      apiUserId: null,
      playSlotsDefaults: DEFAULT_PLAY_SLOTS,
      playerPlaySlots: new Map(),
      warnings,
    });

    expect(extra).toHaveLength(1);
    expect(extra[0]).toEqual(expect.objectContaining({ slotTime: "12H00", court: 1, userId: "c", partnerId: "a" }));
    expect(session.members).toEqual(["a", "b", "c"]);
    expect(session.roundsNeeded).toBe(3);
  });

  it("plafond maxPlayersPerCourt : n'ajoute pas de late joiner au-delà", () => {
    const session: OngoingSession = {
      court: 1,
      anchorStartTime: "10H30",
      members: ["a", "b", "c"],
      roundsBooked: 3,
      roundsNeeded: 3,
      proposedBookings: [],
      groupIndex: 0,
    };
    const warnings: string[] = [];
    const extra = extendSessionForLateJoiners({
      session,
      lateJoinerIds: ["d"],
      joinTime: "10H30",
      targetDate: "2026-08-04",
      groupId: "g1",
      maxPlayersPerCourt: 3,
      maxDailyReservationsPerPlayer: 2,
      availabilityWindowHours: 3,
      availableSlots: [],
      usedSessionIds: new Set(),
      substituteQueue: [],
      existingDailyCounts: {},
      apiUserId: null,
      playSlotsDefaults: DEFAULT_PLAY_SLOTS,
      playerPlaySlots: new Map(),
      warnings,
    });
    expect(extra).toEqual([]);
    expect(session.members).toEqual(["a", "b", "c"]);
    expect(warnings.some((w) => w.includes("impossible d'ajouter d"))).toBe(true);
  });

  it("un seul prête-nom réutilisable ne peut pas combler 2 rôles au plafond dans le même round (pas d'auto-partenariat)", () => {
    // a et b sont déjà au plafond TeamR (existingDailyCounts) avant même ce round ; le round
    // sélectionne les 2 membres les moins nommés (a, b — comptes 0 dans cette session, avant c
    // qui n'a pas encore été sollicité). "sub1" est le seul prête-nom disponible et reste sous
    // son propre plafond après une utilisation (donc réutilisable) — mais réutilisable ne veut
    // pas dire réutilisable DEUX FOIS dans le même round : le 2e rôle en délicatesse doit échouer
    // faute de prête-nom, pas se voir attribuer "sub1" une seconde fois (ce qui produirait
    // userId === partnerId, une réservation TeamR invalide).
    const session: OngoingSession = {
      court: 1,
      anchorStartTime: "10H30",
      members: ["a", "b", "c"],
      roundsBooked: 0,
      roundsNeeded: 0,
      proposedBookings: [],
      groupIndex: 0,
    };
    const warnings: string[] = [];
    const extra = extendSessionForLateJoiners({
      session,
      lateJoinerIds: [],
      joinTime: "10H30",
      targetDate: "2026-08-04",
      groupId: "g1",
      maxPlayersPerCourt: 3,
      maxDailyReservationsPerPlayer: 2,
      availabilityWindowHours: 3,
      availableSlots: [],
      usedSessionIds: new Set(),
      substituteQueue: ["sub1"],
      existingDailyCounts: { a: 2, b: 2 },
      apiUserId: null,
      playSlotsDefaults: DEFAULT_PLAY_SLOTS,
      playerPlaySlots: new Map(),
      warnings,
    });

    expect(extra).toEqual([]);
    expect(extra.some((b) => b.userId === b.partnerId)).toBe(false);
    expect(warnings.filter((w) => w.includes("sub1"))).toHaveLength(1);
    expect(
      warnings.some(
        (w) => w.includes("impossible de prolonger") && w.includes("b") && w.includes("aucun prête-nom disponible"),
      ),
    ).toBe(true);
  });

  it("moins de 2 joueurs confirmés après fusion des late joiners : ne propose aucune réservation à 1 seul nom, warning explicite (finding 3, revue finale 2026-08-23)", () => {
    // Tous les rounds précédents sur ce court ont été joués sous prête-nom (buildOngoingSessionsFromPlan
    // ne garde que les joueurs confirmés dans `members`) : la session démarre avec 0 membre confirmé,
    // et 1 seul late joiner rejoint. Sans le garde `members.length < 2`, la sélection adaptative
    // indexerait `sortedByCount[1]` (undefined) et produirait une réservation avec partnerId undefined.
    const session: OngoingSession = {
      court: 1,
      anchorStartTime: "10H30",
      members: [],
      roundsBooked: 1,
      roundsNeeded: 0,
      proposedBookings: [
        {
          sessionId: "s-1-10H30",
          userId: "sub-a",
          partnerId: "sub-b",
          startDate: "2026-08-04T10:30:00+02:00",
          court: 1,
          slotTime: "10H30",
          slotEndTime: "11H15",
          groupId: "g1",
        },
      ],
      groupIndex: 0,
    };
    const warnings: string[] = [];
    const extra = extendSessionForLateJoiners({
      session,
      lateJoinerIds: ["x"],
      joinTime: "10H30",
      targetDate: "2026-08-04",
      groupId: "g1",
      maxPlayersPerCourt: 3,
      maxDailyReservationsPerPlayer: 3,
      availabilityWindowHours: 3,
      availableSlots: [...makeSlots([1], "11H15", "12H00")],
      usedSessionIds: new Set(),
      substituteQueue: [],
      existingDailyCounts: {},
      apiUserId: null,
      playSlotsDefaults: DEFAULT_PLAY_SLOTS,
      playerPlaySlots: new Map(),
      warnings,
    });

    expect(extra).toEqual([]);
    expect(extra.some((b) => b.partnerId === undefined)).toBe(false);
    expect(warnings.some((w) => w.includes("pas assez de joueurs confirmés"))).toBe(true);
  });

  it("le même prête-nom réutilisé sur 2 rounds de prolongation successifs ne duplique pas l'avertissement (finding 4, régression pré-refactor)", () => {
    const session: OngoingSession = {
      court: 1,
      anchorStartTime: "10H30",
      members: ["a", "b"],
      roundsBooked: 0,
      roundsNeeded: 0,
      proposedBookings: [],
      groupIndex: 0,
    };
    const warnings: string[] = [];
    extendSessionForLateJoiners({
      session,
      lateJoinerIds: [],
      joinTime: "10H30",
      targetDate: "2026-08-04",
      groupId: "g1",
      maxPlayersPerCourt: 3,
      maxDailyReservationsPerPlayer: 1,
      availabilityWindowHours: 5,
      availableSlots: [...makeSlots([1], "10H30", "11H15"), ...makeSlots([1], "11H15", "12H00")],
      usedSessionIds: new Set(),
      substituteQueue: ["sub1"],
      existingDailyCounts: { a: 1, b: 1 },
      apiUserId: null,
      playSlotsDefaults: { defaultMinPlaySlots: 2, defaultMaxPlaySlots: 2 },
      playerPlaySlots: new Map(),
      warnings,
    });

    const substituteWarnings = warnings.filter((w) => w.includes("prolongation TeamR avec prête-nom sub1"));
    expect(substituteWarnings).toHaveLength(1);
  });

  it("le titulaire de la clé API n'est jamais évincé de la file des prête-noms pour avoir 'atteint' un plafond qui ne s'applique pas à lui (finding 5, revue finale)", () => {
    // "api-user" est le seul prête-nom disponible et est aussi le titulaire de la clé API — avec un
    // plafond à 1, sa toute première utilisation (projected = 0 + 0 + 1 = 1 >= cap) déclenche déjà
    // la branche d'éviction : sans l'exemption, il serait retiré de substituteQueue dès ce round,
    // alors qu'il n'a lui-même aucun plafond réel.
    const session: OngoingSession = {
      court: 1,
      anchorStartTime: "10H30",
      members: ["a", "b"],
      roundsBooked: 0,
      roundsNeeded: 0,
      proposedBookings: [],
      groupIndex: 0,
    };
    const substituteQueue = ["api-user"];
    const warnings: string[] = [];
    extendSessionForLateJoiners({
      session,
      lateJoinerIds: [],
      joinTime: "10H30",
      targetDate: "2026-08-04",
      groupId: "g1",
      maxPlayersPerCourt: 3,
      maxDailyReservationsPerPlayer: 1,
      availabilityWindowHours: 5,
      availableSlots: [...makeSlots([1], "10H30", "11H15")],
      usedSessionIds: new Set(),
      substituteQueue,
      existingDailyCounts: { a: 1, b: 0 },
      apiUserId: "api-user",
      playSlotsDefaults: { defaultMinPlaySlots: 1, defaultMaxPlaySlots: 1 },
      playerPlaySlots: new Map(),
      warnings,
    });

    // "api-user" a bien été utilisé (warning de prolongation avec prête-nom) mais est resté dans la
    // file — jamais évincé pour un plafond qui ne s'applique pas à lui.
    expect(warnings.some((w) => w.includes("prolongation TeamR avec prête-nom api-user"))).toBe(true);
    expect(substituteQueue).toEqual(["api-user"]);
  });
});

describe("findMergeableSession", () => {
  it("trouve une session dans la fenêtre de disponibilité avec de la place", () => {
    const session: OngoingSession = {
      court: 1,
      anchorStartTime: "10H30",
      members: ["a", "b"],
      roundsBooked: 1,
      roundsNeeded: 2,
      proposedBookings: [
        {
          sessionId: "s1",
          userId: "a",
          partnerId: "b",
          startDate: "2026-08-04T10:30:00+02:00",
          court: 1,
          slotTime: "10H30",
          slotEndTime: "11H15",
          groupId: "g1",
        },
      ],
      groupIndex: 0,
    };
    expect(findMergeableSession([session], "11H15", 1, 3, 3)).toBe(session);
    expect(findMergeableSession([session], "11H15", 2, 3, 3)).toBeNull(); // dépasse maxPlayersPerCourt
  });
});
