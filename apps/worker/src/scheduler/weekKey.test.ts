import { describe, expect, it } from "vitest";
import { computeTargetDate, computeWeekKey } from "./weekKey.js";

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
