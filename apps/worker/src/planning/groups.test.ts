import { describe, expect, it } from "vitest";
import { buildGroupsForBooking, computeRoundsNeededForMembers, orderMembersByDemand, teamrNamesForRound } from "./groups.js";
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

describe("computeRoundsNeededForMembers", () => {
  it("groupe de 2, préférences par défaut (minSlots=2) : 2 rounds", () => {
    expect(computeRoundsNeededForMembers(["a", "b"], defaults, new Map())).toBe(2);
  });

  it("groupe de 2, un membre à minSlots=3 : 3 rounds (les 2 jouent toujours ensemble)", () => {
    const overrides = new Map<string, PlayerPlaySlots>([["a", { minSlots: 3, maxSlots: 3 }]]);
    expect(computeRoundsNeededForMembers(["a", "b"], defaults, overrides)).toBe(3);
  });

  it("groupe de 3, préférences par défaut : 3 rounds (calcul manuel utilisateur, régression 2026-08-23)", () => {
    expect(computeRoundsNeededForMembers(["a", "b", "c"], defaults, new Map())).toBe(3);
  });

  it("groupe de 3, un membre en position 0 à minSlots=3 : 4 rounds (pas 6 — pas d'arrondi à un cycle complet)", () => {
    const overrides = new Map<string, PlayerPlaySlots>([["a", { minSlots: 3, maxSlots: 3 }]]);
    // "a" doit être en position 0 (appelant : orderMembersByDemand avant cet appel).
    expect(computeRoundsNeededForMembers(["a", "b", "c"], defaults, overrides)).toBe(4);
  });
});

describe("buildGroupsForBooking", () => {
  it("effectif pair : groupes de 2, roundsNeeded = minSlots par défaut", () => {
    const result = buildGroupsForBooking(["a", "b", "c", "d"], [], defaults, new Map(), 3);
    expect(result.groups).toEqual([
      { members: ["a", "b"], roundsNeeded: 2 },
      { members: ["c", "d"], roundsNeeded: 2 },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.remainingSubstituteIds).toEqual([]);
  });

  it("effectif impair : le dernier joueur rejoint le 1er groupe, roundsNeeded recalculé pour le trio", () => {
    const result = buildGroupsForBooking(["a", "b", "c", "d", "e"], [], defaults, new Map(), 3);
    expect(result.groups).toEqual([
      { members: ["a", "b", "e"], roundsNeeded: 3 },
      { members: ["c", "d"], roundsNeeded: 2 },
    ]);
    expect(result.warnings.some((w) => w.includes("Effectif impair"))).toBe(true);
  });

  it("scénario régression 2026-08-23 : trio avec un membre à minSlots=3 → 4 rounds, pas 6", () => {
    const overrides = new Map<string, PlayerPlaySlots>([["a", { minSlots: 3, maxSlots: 3 }]]);
    const result = buildGroupsForBooking(["a", "b", "c"], [], defaults, overrides, 3);
    expect(result.groups).toEqual([{ members: ["a", "b", "c"], roundsNeeded: 4 }]);
  });

  it("préférence individuelle sur une paire classique (bug annexe corrigé) : roundsNeeded suit le max des préférences", () => {
    const overrides = new Map<string, PlayerPlaySlots>([["a", { minSlots: 3, maxSlots: 3 }]]);
    const result = buildGroupsForBooking(["a", "b"], [], defaults, overrides, 3);
    expect(result.groups).toEqual([{ members: ["a", "b"], roundsNeeded: 3 }]);
  });

  it("effectif impair avec prête-nom disponible : le prête-nom n'est jamais utilisé pour compléter l'effectif (règle 2026-08-02 héritée de pairing.ts)", () => {
    const result = buildGroupsForBooking(["a", "b", "c"], ["sub-1"], defaults, new Map(), 3);
    expect(result.groups).toEqual([{ members: ["a", "b", "c"], roundsNeeded: 3 }]);
    expect(result.remainingSubstituteIds).toEqual(["sub-1"]);
  });

  it("effectif impair, maxPlayersPerCourt=2 (plafond club sous 3) : le joueur en rotation n'est PAS fusionné, 3 groupes de 2 + warning sans ligne TeamR", () => {
    const result = buildGroupsForBooking(["a", "b", "c", "d", "e", "f", "g"], [], defaults, new Map(), 2);
    expect(result.groups).toEqual([
      { members: ["a", "b"], roundsNeeded: 2 },
      { members: ["c", "d"], roundsNeeded: 2 },
      { members: ["e", "f"], roundsNeeded: 2 },
    ]);
    expect(
      result.warnings.some(
        (w) => w.includes("Effectif impair") && w.includes("g") && w.includes("plafond 2 joueurs/court"),
      ),
    ).toBe(true);
  });
});
