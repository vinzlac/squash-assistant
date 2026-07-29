import { describe, expect, it } from "vitest";
import { buildPairsForGroupBooking } from "./pairing.js";

describe("buildPairsForGroupBooking", () => {
  it("effectif pair : forme des paires successives, pas de rotation ni prête-nom consommé", () => {
    const result = buildPairsForGroupBooking(["a", "b", "c", "d"], ["sub-1"]);
    expect(result.pairs).toEqual([
      { userId: "a", partnerId: "b" },
      { userId: "c", partnerId: "d" },
    ]);
    expect(result.rotatingPlayerIds).toEqual([]);
    expect(result.remainingSubstituteIds).toEqual(["sub-1"]);
  });

  it("effectif impair avec prête-nom dispo : le dernier joueur est apparié au 1er prête-nom", () => {
    const result = buildPairsForGroupBooking(["a", "b", "c"], ["sub-1", "sub-2"]);
    expect(result.pairs).toEqual([
      { userId: "a", partnerId: "b" },
      { userId: "c", partnerId: "sub-1" },
    ]);
    expect(result.rotatingPlayerIds).toEqual([]);
    expect(result.remainingSubstituteIds).toEqual(["sub-2"]);
  });

  it("effectif impair sans prête-nom : le dernier joueur unique tourne (rotatingPlayerIds), pas de paire pour lui", () => {
    const result = buildPairsForGroupBooking(["a", "b", "c"], []);
    expect(result.pairs).toEqual([{ userId: "a", partnerId: "b" }]);
    expect(result.rotatingPlayerIds).toEqual(["c"]);
    expect(result.remainingSubstituteIds).toEqual([]);
  });

  it("dédoublonne les ids en conservant l'ordre d'apparition", () => {
    const result = buildPairsForGroupBooking(["a", "b", "a", "c"], []);
    expect(result.pairs).toEqual([{ userId: "a", partnerId: "b" }]);
    expect(result.rotatingPlayerIds).toEqual(["c"]);
  });

  it("lève une erreur si moins de 2 joueurs uniques", () => {
    expect(() => buildPairsForGroupBooking(["a"], [])).toThrowError("NEED_AT_LEAST_TWO_PLAYERS");
    expect(() => buildPairsForGroupBooking(["a", "a"], [])).toThrowError("NEED_AT_LEAST_TWO_PLAYERS");
  });

  it("dédoublonne aussi les prête-noms", () => {
    const result = buildPairsForGroupBooking(["a", "b", "c"], ["sub-1", "sub-1"]);
    expect(result.pairs).toEqual([
      { userId: "a", partnerId: "b" },
      { userId: "c", partnerId: "sub-1" },
    ]);
    expect(result.remainingSubstituteIds).toEqual([]);
  });
});
