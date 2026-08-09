import { describe, expect, it } from "vitest";
import { parisLocalInputToDate } from "./clubClosures";

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
