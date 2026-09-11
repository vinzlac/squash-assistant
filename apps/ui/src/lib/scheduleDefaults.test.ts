import { describe, expect, it } from "vitest";
import { SCHEDULE_DEFAULTS_FALLBACK, validateScheduleDefaults } from "./scheduleDefaults";

describe("validateScheduleDefaults", () => {
  it("accepte les défauts historiques (N = M = 7, 10:00 / 21:30)", () => {
    expect(validateScheduleDefaults(SCHEDULE_DEFAULTS_FALLBACK)).toEqual([]);
  });

  it("accepte N ≠ M (sondage J-9, décision J-7)", () => {
    expect(
      validateScheduleDefaults({ ...SCHEDULE_DEFAULTS_FALLBACK, defaultPollDaysBefore: 9, defaultDecisionDaysBefore: 7 }),
    ).toEqual([]);
  });

  it("refuse M > N", () => {
    expect(validateScheduleDefaults({ ...SCHEDULE_DEFAULTS_FALLBACK, defaultDecisionDaysBefore: 8 })).toContain(
      "La décision (8 j avant) ne peut pas précéder le sondage (7 j avant).",
    );
  });

  it("refuse M = N avec l'heure de décision avant celle du sondage", () => {
    expect(validateScheduleDefaults({ ...SCHEDULE_DEFAULTS_FALLBACK, defaultDecisionTime: "09:00" })).toContain(
      "Même jour : l'heure de décision (09:00) doit être après l'heure du sondage (10:00).",
    );
  });

  it("refuse une heure mal formée", () => {
    expect(validateScheduleDefaults({ ...SCHEDULE_DEFAULTS_FALLBACK, defaultPollTime: "10h" })).toContain(
      "Heure du sondage invalide : « 10h » (attendu HH:MM).",
    );
  });
});
