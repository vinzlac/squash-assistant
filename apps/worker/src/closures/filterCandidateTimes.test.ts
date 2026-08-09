import { describe, expect, it } from "vitest";
import { filterCandidateTimesByClosures } from "./filterCandidateTimes.js";

describe("filterCandidateTimesByClosures", () => {
  it("aucune fermeture → toutes ouvertes", () => {
    const r = filterCandidateTimesByClosures("2026-08-15", ["18H45", "19H30"], []);
    expect(r).toEqual({ openTimes: ["18H45", "19H30"], closedTimes: [] });
  });

  it("journée entière fermée → toutes fermées", () => {
    const r = filterCandidateTimesByClosures("2026-08-15", ["18H45", "19H30"], [
      { startsAt: new Date("2026-08-14T22:00:00.000Z"), endsAt: new Date("2026-08-15T22:00:00.000Z") }, // 15 août Paris (UTC+2 été)
    ]);
    expect(r.openTimes).toEqual([]);
    expect(r.closedTimes).toEqual(["18H45", "19H30"]);
  });

  it("fermeture partielle → partitionne", () => {
    // Ferme jusqu'à 19:00 Paris le 15/08/2026 → 18H45 fermé, 19H30 ouvert
    const r = filterCandidateTimesByClosures("2026-08-15", ["18H45", "19H30"], [
      { startsAt: new Date("2026-08-14T22:00:00.000Z"), endsAt: new Date("2026-08-15T17:00:00.000Z") }, // ends 19:00 Paris
    ]);
    expect(r.closedTimes).toEqual(["18H45"]);
    expect(r.openTimes).toEqual(["19H30"]);
  });

  it("borne ends_at exclusive : instant == endsAt → ouvert", () => {
    const endsAt = new Date("2026-08-15T16:45:00.000Z"); // 18:45 Paris
    const r = filterCandidateTimesByClosures("2026-08-15", ["18H45"], [
      { startsAt: new Date("2026-08-14T22:00:00.000Z"), endsAt },
    ]);
    expect(r.openTimes).toEqual(["18H45"]);
    expect(r.closedTimes).toEqual([]);
  });
});
