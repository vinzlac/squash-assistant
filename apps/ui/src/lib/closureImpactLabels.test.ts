import { describe, expect, it } from "vitest";
import { formatClosedTimes, impactSummary, stageLabel } from "./closureImpactLabels";

describe("stageLabel", () => {
  it("traduit les étapes en français", () => {
    expect(stageLabel("awaiting-decision")).toBe("sondage en cours");
    expect(stageLabel("awaiting-plan")).toBe("votes figés, plan à calculer");
    expect(stageLabel("awaiting-go")).toBe("plan calculé, en attente du go");
    expect(stageLabel("not-started")).toBe("pas encore démarré");
    expect(stageLabel("not-created")).toBe("sondage à venir");
    expect(stageLabel("error")).toBe("en erreur");
  });
});

describe("formatClosedTimes", () => {
  it("18H45 → 18h45, 19H00 → 19h", () => {
    expect(formatClosedTimes(["18H45", "19H00"])).toBe("18h45, 19h");
  });
});

describe("impactSummary", () => {
  it("aucun impact", () => {
    expect(impactSummary({ running: [], planned: [], errored: [] })).toBe("Aucun job concerné.");
  });
  it("compte les jobs arrêtés et prévus", () => {
    const e = { ruleId: "r", ruleLabel: "Samedi", jobId: "j", targetDate: "2026-09-19", stage: "awaiting-decision" as const, closedTimes: ["18H45"] };
    expect(impactSummary({ running: [e], planned: [e, e], errored: [] })).toBe("1 job en cours sera arrêté, 2 jobs prévus recevront le message de fermeture.");
  });
});
