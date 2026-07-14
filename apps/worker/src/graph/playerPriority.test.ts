import { describe, expect, it } from "vitest";
import { prioritizePlayers } from "./playerPriority.js";

describe("prioritizePlayers", () => {
  it("met les priorityBookers en tête même s'ils ont répondu plus tard", () => {
    const confirmed = ["user-bob", "user-alice", "user-carla"];
    const result = prioritizePlayers(confirmed, ["user-alice"]);
    expect(result).toEqual(["user-alice", "user-bob", "user-carla"]);
  });

  it("respecte l'ordre de priorité quand plusieurs priorityBookers sont confirmés", () => {
    const confirmed = ["user-carla", "user-bob", "user-alice", "user-martin"];
    const result = prioritizePlayers(confirmed, ["user-martin", "user-alice"]);
    expect(result).toEqual(["user-martin", "user-alice", "user-carla", "user-bob"]);
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
