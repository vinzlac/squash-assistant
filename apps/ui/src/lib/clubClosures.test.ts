import { describe, expect, it } from "vitest";
import {
  addCalendarDaysYmd,
  formatWholeDayParisLabel,
  isWholeDayParisInterval,
  parisLocalInputToDate,
  parisWholeDaysToInterval,
} from "./clubClosures";

describe("parisLocalInputToDate", () => {
  it("utilise l'heure d'été d'avril à octobre", () => {
    expect(parisLocalInputToDate("2026-08-09T18:45").toISOString()).toBe("2026-08-09T16:45:00.000Z");
  });

  it("utilise l'heure d'hiver de novembre à mars", () => {
    expect(parisLocalInputToDate("2026-01-09T18:45").toISOString()).toBe("2026-01-09T17:45:00.000Z");
  });

  it("rejette une valeur datetime-local invalide", () => {
    expect(() => parisLocalInputToDate("2026-08-09 18:45")).toThrow(/invalid datetime-local/);
  });
});

describe("parisWholeDaysToInterval", () => {
  it("une journée : [minuit, minuit lendemain)", () => {
    const { startsAt, endsAt } = parisWholeDaysToInterval("2026-08-15", "2026-08-15");
    expect(startsAt.toISOString()).toBe("2026-08-14T22:00:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-08-15T22:00:00.000Z");
    expect(isWholeDayParisInterval(startsAt, endsAt)).toBe(true);
    expect(formatWholeDayParisLabel(startsAt, endsAt)).toMatch(/Journée entière/);
  });

  it("plusieurs journées inclusives", () => {
    const { startsAt, endsAt } = parisWholeDaysToInterval("2026-08-15", "2026-08-17");
    expect(startsAt.toISOString()).toBe("2026-08-14T22:00:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-08-17T22:00:00.000Z");
    expect(formatWholeDayParisLabel(startsAt, endsAt)).toMatch(/Journées entières/);
  });

  it("rejette fin avant début", () => {
    expect(() => parisWholeDaysToInterval("2026-08-17", "2026-08-15")).toThrow(/end date before start/);
  });
});

describe("addCalendarDaysYmd", () => {
  it("passe au mois suivant", () => {
    expect(addCalendarDaysYmd("2026-08-31", 1)).toBe("2026-09-01");
  });
});
