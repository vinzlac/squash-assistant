import { describe, expect, it } from "vitest";
import {
  effectiveMinutesPerSlot,
  slotsNeededFromJoin,
  targetEffectiveMinutes,
} from "./effectivePlayTime.js";

describe("effectivePlayTime", () => {
  it("effectif plein à 2 joueurs", () => {
    expect(effectiveMinutesPerSlot(2)).toBe(45);
  });

  it("rotation à 3 : 30 min effectives par créneau", () => {
    expect(effectiveMinutesPerSlot(3)).toBe(30);
  });

  it("cible 90 min pour slotsPerPlayer=2", () => {
    expect(targetEffectiveMinutes(2)).toBe(90);
  });

  it("Martin (n=3, quota 2) : 3 créneaux depuis son arrivée", () => {
    expect(slotsNeededFromJoin(3, 2)).toBe(3);
  });
});
