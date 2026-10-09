import { describe, expect, it } from "vitest";
import { buildPollQuestionPreview } from "./pipelinePreview";

describe("buildPollQuestionPreview — clôture (spec 2026-10-09 §1.1)", () => {
  const closure = { decisionDaysBefore: 5, decisionTime: "09:00" };

  it("ajoute la clôture comme le worker", () => {
    expect(buildPollQuestionPreview("2026-10-10", ["10H30"], closure, new Date("2026-10-03T08:00:00Z"))).toBe(
      "Squash samedi 10 octobre à 10h30 ? (réponses jusqu'au lundi 5 octobre à 9h)",
    );
  });

  it("decisionDaysBefore = 0", () => {
    expect(
      buildPollQuestionPreview("2026-10-10", ["10H30"], { decisionDaysBefore: 0, decisionTime: "08:00" }, new Date("2026-10-09T10:00:00Z")),
    ).toBe("Squash samedi 10 octobre à 10h30 ? (réponses jusqu'au samedi 10 octobre à 8h)");
  });

  it("clôture passée ou réglage absent : pas de mention", () => {
    expect(buildPollQuestionPreview("2026-10-10", ["10H30"], closure, new Date("2026-10-05T07:00:00Z"))).toBe(
      "Squash samedi 10 octobre à 10h30 ?",
    );
    expect(buildPollQuestionPreview("2026-10-10", ["10H30"])).toBe("Squash samedi 10 octobre à 10h30 ?");
  });
});
