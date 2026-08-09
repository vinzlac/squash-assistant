import { describe, expect, it } from "vitest";
import {
  SUBSTITUTE_VOLUNTEER_POLL_OPTION,
  buildClubClosedMessage,
  buildPollOptions,
  buildPollQuestion,
} from "./pollQuestion.js";

describe("buildPollOptions", () => {
  it("une heure candidate : heure + Non + prête-nom volontaire (ADR-017)", () => {
    expect(buildPollOptions(["18H45"])).toEqual(["18H45", "Non", SUBSTITUTE_VOLUNTEER_POLL_OPTION]);
  });

  it("plusieurs heures candidates : une option par heure + Non + prête-nom volontaire", () => {
    expect(buildPollOptions(["18H45", "19H30"])).toEqual([
      "18H45",
      "19H30",
      "Non",
      SUBSTITUTE_VOLUNTEER_POLL_OPTION,
    ]);
  });
});

describe("buildPollQuestion", () => {
  it("une seule heure candidate : question fermée classique", () => {
    const question = buildPollQuestion("2026-08-01", ["10H30"]);
    expect(question).toContain("10h30");
    expect(question).not.toContain("à quelle heure");
  });

  it("plusieurs heures candidates : question ouverte sur l'heure", () => {
    const question = buildPollQuestion("2026-07-21", ["18H45", "19H30"]);
    expect(question).toContain("à quelle heure");
    expect(question).toContain("18h45");
    expect(question).toContain("19h30");
  });
});

describe("buildClubClosedMessage", () => {
  it("préfixe puc fermé + date informelle + pas de squash", () => {
    const msg = buildClubClosedMessage("2026-08-15");
    expect(msg.startsWith("puc fermé ")).toBe(true);
    expect(msg.endsWith(" pas de squash")).toBe(true);
    expect(msg).toMatch(/15 août/);
  });
});

describe("buildPollQuestion avec closedTimes", () => {
  it("ajoute la mention des heures fermées", () => {
    const q = buildPollQuestion("2026-08-15", ["19H30"], ["18H45"]);
    expect(q).toContain("19h30");
    expect(q).toContain("18h45");
    expect(q).toContain("puc fermé");
  });
});
