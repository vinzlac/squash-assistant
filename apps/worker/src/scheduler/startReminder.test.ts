import { describe, expect, it } from "vitest";
import type { BookingPlanGroup } from "../graph/state.js";
import {
  START_REMINDER_REASONS,
  START_REMINDER_SINCE,
  evaluateStartReminder,
  firstReservedSlotMinutes,
  formatParisMinutes,
  parisMinutesNow,
  startReminderOffsetMinutes,
  type StartReminderInput,
} from "./startReminder.js";

function group(startTime: string, slots: Array<{ id: string; time: string; end: string }>, outOfWindow: string[] = []): BookingPlanGroup {
  return {
    startTime,
    outOfWindowSessionIds: outOfWindow,
    plan: {
      dryRun: false,
      proposedBookings: slots.map((s) => ({ sessionId: s.id, court: 2, userId: "u1", partnerId: "u2", slotTime: s.time, slotEndTime: s.end })),
      warnings: [],
      meta: {
        courtsNeeded: 1,
        roundsPlanned: 1,
        dryRun: false,
        groupLabel: "test",
        recurringWeekday: 2,
        recurringStartTime: startTime,
        slotsPerPlayer: 2,
        groupMinSlotsPerPlayer: 1,
        groupMaxSlotsPerPlayer: 3,
        pairCount: 2,
      },
    },
  } as BookingPlanGroup;
}

describe("parisMinutesNow", () => {
  it("heure d'été : 14:45Z → 16h45 Paris", () => {
    expect(parisMinutesNow(new Date("2026-08-11T14:45:00Z"))).toBe(16 * 60 + 45);
  });
  it("heure d'hiver (après le 25/10/2026) : 15:45Z → 16h45 Paris", () => {
    expect(parisMinutesNow(new Date("2026-10-27T15:45:00Z"))).toBe(16 * 60 + 45);
  });
  it("minuit Paris → 0", () => {
    expect(parisMinutesNow(new Date("2026-08-10T22:00:00Z"))).toBe(0);
  });
});

describe("firstReservedSlotMinutes", () => {
  it("prend le plus tôt en minutes, pas en texte (9H00 < 10H30)", () => {
    const groups = [group("10H30", [{ id: "a", time: "10H30", end: "11H15" }]), group("9H00", [{ id: "b", time: "9H00", end: "9H45" }])];
    expect(firstReservedSlotMinutes(groups, [])).toBe(9 * 60);
  });
  it("ignore les créneaux hors fenêtre et refusés", () => {
    const groups = [
      group("18H45", [
        { id: "a", time: "18H45", end: "19H30" },
        { id: "b", time: "19H30", end: "20H15" },
      ]),
      group("17H15", [{ id: "c", time: "17H15", end: "18H00" }], ["c"]),
    ];
    const failures = [{ sessionId: "a", court: 2, slotTime: "18H45", slotEndTime: "19H30", userId: "u1", partnerId: null, reason: null, message: "", rawError: "" }];
    expect(firstReservedSlotMinutes(groups, failures)).toBe(19 * 60 + 30);
  });
  it("lit le format TeamR « 18H45 » en minutes", () => {
    expect(firstReservedSlotMinutes([group("18H45", [{ id: "a", time: "18H45", end: "19H30" }])], [])).toBe(18 * 60 + 45);
  });
  it("null si aucun créneau réservé", () => {
    expect(firstReservedSlotMinutes([], [])).toBeNull();
  });
});

describe("startReminderOffsetMinutes", () => {
  it("stable pour un même id, toujours dans [-10, 10)", () => {
    for (const id of ["job-1", "a3f0c2d4-1111-2222-3333-444455556666", "x", ""]) {
      const v = startReminderOffsetMinutes(id);
      expect(v).toBe(startReminderOffsetMinutes(id));
      expect(v).toBeGreaterThanOrEqual(-10);
      expect(v).toBeLessThan(10);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("formatParisMinutes", () => {
  it("1005 → 16h45, 540 → 9h00", () => {
    expect(formatParisMinutes(1005)).toBe("16h45");
    expect(formatParisMinutes(540)).toBe("9h00");
  });
});

describe("evaluateStartReminder", () => {
  const JOB_ID = "job-1";
  const offset = startReminderOffsetMinutes(JOB_ID);
  // premier créneau 18H45, délai 120 → heure d'envoi 16h45 + offset
  const plannedMin = 18 * 60 + 45 - 120 + offset;
  const atParis = (minutes: number) => new Date(Date.UTC(2026, 7, 11, 0, 0) - 2 * 3600_000 + minutes * 60_000); // 2026-08-11, UTC+2

  function input(overrides: {
    rule?: Partial<StartReminderInput["rule"]>;
    job?: Partial<StartReminderInput["job"]>;
    isActiveJobForDate?: boolean;
    stage?: StartReminderInput["status"]["stage"];
    values?: Partial<StartReminderInput["status"]["values"]>;
    now?: Date;
  } = {}): StartReminderInput {
    return {
      rule: {
        enabled: true,
        startReminderEnabled: true,
        startReminderMinutesBefore: 120,
        decisionDaysBefore: 7,
        whatsappGroupJid: "origine@g.us",
        confirmationNotifyWhatsappGroupJid: null,
        ...overrides.rule,
      },
      job: {
        id: JOB_ID,
        targetDate: "2026-08-11",
        cancelledAt: null,
        createdAt: new Date(START_REMINDER_SINCE.getTime() + 1),
        startReminderSentAt: null,
        ...overrides.job,
      },
      isActiveJobForDate: overrides.isActiveJobForDate ?? true,
      status: {
        stage: overrides.stage ?? "finished-announced",
        values: {
          dryRun: false,
          reservationFailures: [],
          bookingPlanGroups: [group("18H45", [{ id: "s1", time: "18H45", end: "19H30" }])],
          ...overrides.values,
        },
      },
      now: overrides.now ?? atParis(plannedMin),
    };
  }

  it("1. déjà envoyé → sent (prime sur tout)", () => {
    expect(evaluateStartReminder(input({ job: { startReminderSentAt: new Date(), cancelledAt: new Date() } })).state).toBe("sent");
  });
  it("2. option décochée ou règle désactivée → disabled avec motif « Non activé »", () => {
    const expected = { state: "disabled", reason: START_REMINDER_REASONS.notEnabled };
    expect(evaluateStartReminder(input({ rule: { startReminderEnabled: false } }))).toEqual(expected);
    expect(evaluateStartReminder(input({ rule: { enabled: false } }))).toEqual(expected);
  });
  it("3. job créé avant la fonctionnalité → disabled sans motif (UI « — »), jamais missed", () => {
    const r = evaluateStartReminder(input({ job: { createdAt: new Date(START_REMINDER_SINCE.getTime() - 1), targetDate: "2026-08-01" } }));
    expect(r).toEqual({ state: "disabled" });
  });
  it("4. décision le jour du match → skipped", () => {
    expect(evaluateStartReminder(input({ rule: { decisionDaysBefore: 0 } }))).toEqual({ state: "skipped", reason: START_REMINDER_REASONS.sameDayDecision });
  });
  it("5. job annulé (et non annoncé) → motif annulé, prioritaire", () => {
    expect(evaluateStartReminder(input({ job: { cancelledAt: new Date() }, stage: "awaiting-go" })).reason).toBe(START_REMINDER_REASONS.cancelled);
  });
  it("6. pas le job actif de sa date → skipped", () => {
    expect(evaluateStartReminder(input({ isActiveJobForDate: false })).reason).toBe(START_REMINDER_REASONS.notActiveJob);
  });
  it("7. job non annoncé le jour du match (ou après) → skipped", () => {
    expect(evaluateStartReminder(input({ stage: "awaiting-go" }))).toEqual({ state: "skipped", reason: START_REMINDER_REASONS.notAnnounced });
    expect(evaluateStartReminder(input({ stage: "finished-no-plan", job: { targetDate: "2026-08-10" } })).reason).toBe(START_REMINDER_REASONS.notAnnounced);
  });
  it("7bis. job non annoncé, match à venir → waiting « En attente de l'annonce », sans heure", () => {
    expect(evaluateStartReminder(input({ stage: "awaiting-decision", job: { targetDate: "2026-08-15" } }))).toEqual({
      state: "waiting",
      reason: START_REMINDER_REASONS.awaitingAnnounce,
    });
  });
  it("8. aucun créneau réservé → skipped", () => {
    expect(evaluateStartReminder(input({ values: { bookingPlanGroups: [] } })).reason).toBe(START_REMINDER_REASONS.noReservedSlot);
  });
  it("9. dry-run vers le groupe du sondage → skipped ; vers un groupe de test → envoyable", () => {
    expect(evaluateStartReminder(input({ values: { dryRun: true } })).reason).toBe(START_REMINDER_REASONS.dryRunToPollGroup);
    expect(evaluateStartReminder(input({ values: { dryRun: true }, rule: { confirmationNotifyWhatsappGroupJid: "test@g.us" } })).state).toBe("due");
  });
  it("10. créneau commencé ou date passée → missed", () => {
    expect(evaluateStartReminder(input({ now: atParis(18 * 60 + 45) })).state).toBe("missed");
    expect(evaluateStartReminder(input({ job: { targetDate: "2026-08-10" } })).state).toBe("missed");
  });
  it("11. avant l'heure d'envoi ou date future → waiting avec l'heure prévue", () => {
    const r = evaluateStartReminder(input({ now: atParis(plannedMin - 1) }));
    expect(r).toEqual({ state: "waiting", plannedAt: formatParisMinutes(plannedMin) });
    expect(evaluateStartReminder(input({ job: { targetDate: "2026-08-12" } })).state).toBe("waiting");
  });
  it("12. heure d'envoi atteinte, créneau pas commencé → due", () => {
    expect(evaluateStartReminder(input()).state).toBe("due");
    expect(evaluateStartReminder(input({ now: atParis(18 * 60 + 44) })).state).toBe("due");
  });
  it("délai pris dans la règle passée (live) : 60 min → heure prévue 17h45 + offset", () => {
    const r = evaluateStartReminder(input({ rule: { startReminderMinutesBefore: 60 }, now: atParis(0) }));
    expect(r.plannedAt).toBe(formatParisMinutes(18 * 60 + 45 - 60 + offset));
  });
  it("heure d'hiver (2026-10-27, UTC+1) : due à 16h45 Paris + offset, waiting une minute avant", () => {
    const winterAt = (minutes: number) => new Date(Date.UTC(2026, 9, 27, 0, 0) - 3600_000 + minutes * 60_000);
    const dueAt = 16 * 60 + 45 + offset;
    const winter = { job: { targetDate: "2026-10-27" } };
    expect(evaluateStartReminder(input({ ...winter, now: winterAt(dueAt) })).state).toBe("due");
    expect(evaluateStartReminder(input({ ...winter, now: winterAt(dueAt - 1) })).state).toBe("waiting");
  });
});
