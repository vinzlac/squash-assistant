import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAY_SLOTS,
  buildPlayerPlaySlotsMap,
  resolvePlayerPlaySlots,
} from "./playerPlaySlots.js";

describe("resolvePlayerPlaySlots", () => {
  it("utilise les défauts absents d'override", () => {
    expect(resolvePlayerPlaySlots("a", DEFAULT_PLAY_SLOTS, new Map())).toEqual({
      minSlots: 2,
      maxSlots: 2,
    });
  });

  it("applique la surcharge", () => {
    const overrides = new Map([["a", { minSlots: 3, maxSlots: 4 }]]);
    expect(resolvePlayerPlaySlots("a", DEFAULT_PLAY_SLOTS, overrides)).toEqual({
      minSlots: 3,
      maxSlots: 4,
    });
  });

  it("clamp min ≤ max et bornes 1..6", () => {
    expect(
      resolvePlayerPlaySlots("a", DEFAULT_PLAY_SLOTS, { a: { minSlots: 5, maxSlots: 3 } }),
    ).toEqual({ minSlots: 5, maxSlots: 5 });
  });
});

describe("buildPlayerPlaySlotsMap", () => {
  it("résout chaque id", () => {
    const map = buildPlayerPlaySlotsMap(
      ["a", "b"],
      DEFAULT_PLAY_SLOTS,
      new Map([["b", { minSlots: 1, maxSlots: 3 }]]),
    );
    expect(map.get("a")).toEqual({ minSlots: 2, maxSlots: 2 });
    expect(map.get("b")).toEqual({ minSlots: 1, maxSlots: 3 });
  });
});
