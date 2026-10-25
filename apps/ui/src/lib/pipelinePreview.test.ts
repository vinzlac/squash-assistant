import { describe, expect, it } from "vitest";
import { buildPollQuestionPreview } from "./pipelinePreview";

// Spec roster vivant §4.1 : le sondage n'annonce plus sa clôture.
describe("buildPollQuestionPreview", () => {
  it("aperçu UI sans mention de clôture, une seule heure", () => {
    const preview = buildPollQuestionPreview("2026-10-10", ["10H30"]);
    expect(preview).toBe("Squash samedi 10 octobre à 10h30 ?");
    expect(preview).not.toContain("réponses jusqu'au");
  });

  it("plusieurs heures candidates", () => {
    expect(buildPollQuestionPreview("2026-10-10", ["18H45", "19H30"])).toBe(
      "Squash samedi 10 octobre, à quelle heure : 18h45 ou 19h30 ?",
    );
  });
});
