import { describe, expect, it } from "vitest";
import { orderMembersByDemand, teamrNamesForRound } from "./groups.js";
import type { PlayerPlaySlots, PlaySlotsDefaults } from "./playerPlaySlots.js";

const defaults: PlaySlotsDefaults = { defaultMinPlaySlots: 2, defaultMaxPlaySlots: 2 };

describe("teamrNamesForRound", () => {
  it("groupe de 2 : toujours les mêmes indices, quel que soit le round", () => {
    expect(teamrNamesForRound(2, 0)).toEqual([0, 1]);
    expect(teamrNamesForRound(2, 5)).toEqual([0, 1]);
  });

  it("groupe de 3 : cycle round-robin sur 3 rounds, chaque duo apparaît une fois par cycle puis se répète", () => {
    expect(teamrNamesForRound(3, 0)).toEqual([0, 1]);
    expect(teamrNamesForRound(3, 1)).toEqual([0, 2]);
    expect(teamrNamesForRound(3, 2)).toEqual([1, 2]);
    expect(teamrNamesForRound(3, 3)).toEqual([0, 1]);
    expect(teamrNamesForRound(3, 4)).toEqual([0, 2]);
  });
});

describe("orderMembersByDemand", () => {
  it("groupe de 2 : ordre inchangé", () => {
    expect(orderMembersByDemand(["a", "b"], defaults, new Map())).toEqual(["a", "b"]);
  });

  it("groupe de 3 : trie par minSlots décroissant, le plus exigeant en position 0", () => {
    const overrides = new Map<string, PlayerPlaySlots>([["c", { minSlots: 3, maxSlots: 3 }]]);
    expect(orderMembersByDemand(["a", "b", "c"], defaults, overrides)).toEqual(["c", "a", "b"]);
  });

  it("groupe de 3 sans préférence particulière : ordre stable (tri égal ne réordonne pas)", () => {
    expect(orderMembersByDemand(["a", "b", "c"], defaults, new Map())).toEqual(["a", "b", "c"]);
  });
});
