import { describe, expect, it } from "vitest";
import { computeTargetDate, computeWeekKey, parisCalendarDayBoundsUtc } from "./weekKey.js";

describe("computeTargetDate", () => {
  it("mardi → mardi J+7 (squashacademie-mardi)", () => {
    expect(computeTargetDate(new Date("2026-07-14T10:00:00Z"), 7)).toBe("2026-07-21");
  });

  it("mardi → samedi J+4 (squash-samedi-matin)", () => {
    expect(computeTargetDate(new Date("2026-07-14T10:00:00Z"), 4)).toBe("2026-07-18");
  });
});

describe("computeWeekKey", () => {
  it("retourne le lundi de la semaine ISO", () => {
    expect(computeWeekKey(new Date("2026-07-14T10:00:00Z"))).toBe("2026-07-13");
    // 2026-07-19T20:00:00Z = 22h00 Europe/Paris (UTC+2 en été) → toujours dimanche 19.
    expect(computeWeekKey(new Date("2026-07-19T20:00:00Z"))).toBe("2026-07-13");
  });

  it("raisonne sur le jour calendaire Europe/Paris, pas celui du fuseau système (piège minuit/DST)", () => {
    // 2026-07-19T22:30:00Z = 2026-07-20T00:30 Europe/Paris → déjà lundi en heure locale Paris,
    // alors que la date UTC brute est encore dimanche 19. Si on raisonnait en UTC (comme sur un
    // pod configuré TZ=UTC), on obtiendrait à tort "2026-07-13" au lieu de "2026-07-20".
    expect(computeWeekKey(new Date("2026-07-19T22:30:00Z"))).toBe("2026-07-20");
  });
});

describe("parisCalendarDayBoundsUtc", () => {
  it("borne un jour d'été (+02:00) — un instant juste avant/après minuit Paris tombe hors bornes", () => {
    const { start, end } = parisCalendarDayBoundsUtc("2026-08-11");
    expect(start.toISOString()).toBe("2026-08-10T22:00:00.000Z"); // 2026-08-11T00:00:00+02:00
    expect(end.toISOString()).toBe("2026-08-11T22:00:00.000Z"); // 2026-08-12T00:00:00+02:00
    const justBefore = new Date(start.getTime() - 1);
    const justAfter = new Date(end.getTime() - 1);
    expect(justBefore < start).toBe(true);
    expect(justAfter < end).toBe(true);
  });

  it("borne un jour d'hiver (+01:00)", () => {
    const { start, end } = parisCalendarDayBoundsUtc("2026-01-15");
    expect(start.toISOString()).toBe("2026-01-14T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-01-15T23:00:00.000Z");
  });
});
