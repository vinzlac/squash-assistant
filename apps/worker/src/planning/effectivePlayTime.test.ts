import { describe, expect, it } from "vitest";
import { effectiveMinutesPerSlot } from "./effectivePlayTime.js";

describe("effectivePlayTime", () => {
  it("effectif plein à 2 joueurs", () => {
    expect(effectiveMinutesPerSlot(2)).toBe(45);
  });

  it("rotation à 3 : 30 min effectives par créneau", () => {
    expect(effectiveMinutesPerSlot(3)).toBe(30);
  });
});
