import { describe, expect, it } from "vitest";
import { prioritizePlayers } from "./playerPriority.js";

describe("prioritizePlayers", () => {
  it("met les priorityBookers en tête même s'ils ont répondu plus tard", () => {
    const confirmed = ["user-bob", "user-alice", "user-carla"];
    const result = prioritizePlayers(confirmed, ["user-alice"]);
    expect(result).toEqual(["user-alice", "user-bob", "user-carla"]);
  });

  it("respecte l'ordre de priorité quand plusieurs priorityBookers sont confirmés, en les intercalant pour qu'ils ne soient pas appariés ensemble", () => {
    const confirmed = ["user-carla", "user-bob", "user-alice", "user-martin"];
    const result = prioritizePlayers(confirmed, ["user-martin", "user-alice"]);
    expect(result).toEqual(["user-martin", "user-carla", "user-alice", "user-bob"]);
  });

  it("répartit 2 priorityBookers confirmés sur 2 paires distinctes (donc 2 courts distincts) au lieu de les apparier ensemble", () => {
    // Régression 2026-08-23 : Vincent LACOSTE et Martin MERLOT (priorityBookers de
    // « squash du samedi ») s'étaient retrouvés appariés ensemble sur le court 1
    // (indices 0-1 de expectedPlayerIds), en violation de la règle « 1 seul
    // réservataire prioritaire par court » quand plusieurs courts sont réservés en //.
    const vincent = "60bf2fdd1fd8d20020d2c8a7";
    const martin = "60e23b69a78d1100206b808c";
    const confirmed = [vincent, martin, "user-mustapha", "user-david", "user-henry", "user-hugo"];
    const result = prioritizePlayers(confirmed, [vincent, martin]);

    // buildPairsForGroupBooking apparie les indices [0,1], [2,3], [4,5] : vincent et
    // martin doivent donc atterrir sur des paires (indices pairs) différentes.
    const vincentIndex = result.indexOf(vincent);
    const martinIndex = result.indexOf(martin);
    expect(vincentIndex % 2).toBe(0);
    expect(martinIndex % 2).toBe(0);
    expect(Math.floor(vincentIndex / 2)).not.toBe(Math.floor(martinIndex / 2));
  });

  it("ignore les priorityBookers qui n'ont pas confirmé leur présence", () => {
    const confirmed = ["user-bob", "user-carla"];
    const result = prioritizePlayers(confirmed, ["user-alice"]);
    expect(result).toEqual(["user-bob", "user-carla"]);
  });

  it("retourne la liste telle quelle sans priorityBookers", () => {
    const confirmed = ["user-bob", "user-alice"];
    expect(prioritizePlayers(confirmed, [])).toEqual(confirmed);
  });
});
