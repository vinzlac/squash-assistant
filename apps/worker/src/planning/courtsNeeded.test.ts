import { describe, expect, it } from "vitest";
import { courtsNeededForPlayers } from "./courtsNeeded.js";

describe("courtsNeededForPlayers", () => {
  it("0 joueur → 0 court", () => {
    expect(courtsNeededForPlayers(0)).toBe(0);
  });

  it("remplissage max (défaut, 3 joueurs/court) : 4 joueurs → 2 courts", () => {
    expect(courtsNeededForPlayers(4)).toBe(2);
  });

  it("remplissage max : 3 joueurs → 1 court", () => {
    expect(courtsNeededForPlayers(3)).toBe(1);
  });

  it("remplissage min (2 joueurs/court) : 4 joueurs → 2 courts", () => {
    expect(courtsNeededForPlayers(4, true)).toBe(2);
  });

  it("remplissage min : 3 joueurs → 2 courts (pas 1, plafond min = 2)", () => {
    expect(courtsNeededForPlayers(3, true)).toBe(2);
  });

  it("remplissage min : 6 joueurs → 3 courts", () => {
    expect(courtsNeededForPlayers(6, true)).toBe(3);
  });
});
