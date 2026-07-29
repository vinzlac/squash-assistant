import { describe, expect, it } from "vitest";
import { formatTeamrTimeFromMinutes, slotStartDateIsoHeuristicParis } from "./teamrTime.js";

describe("formatTeamrTimeFromMinutes", () => {
  it("convertit des minutes en libellé TeamR", () => {
    expect(formatTeamrTimeFromMinutes(18 * 60 + 45)).toBe("18H45");
    expect(formatTeamrTimeFromMinutes(9 * 60)).toBe("9H00");
  });
});

describe("slotStartDateIsoHeuristicParis", () => {
  it("applique +02:00 en été (avril à octobre)", () => {
    expect(slotStartDateIsoHeuristicParis("2026-08-04", "18H45")).toBe("2026-08-04T18:45:00+02:00");
  });

  it("applique +01:00 en hiver (novembre à mars)", () => {
    expect(slotStartDateIsoHeuristicParis("2026-01-15", "10H30")).toBe("2026-01-15T10:30:00+01:00");
  });

  it("retourne null sur un horaire invalide", () => {
    expect(slotStartDateIsoHeuristicParis("2026-08-04", "invalide")).toBeNull();
  });
});
