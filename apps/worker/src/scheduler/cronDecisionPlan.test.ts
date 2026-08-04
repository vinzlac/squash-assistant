import { describe, expect, it } from "vitest";
import { resolveCronDecisionPlan } from "./cronDecisionPlan.js";

describe("resolveCronDecisionPlan", () => {
  it("lance collecte + plan si en attente de décision", () => {
    expect(resolveCronDecisionPlan({ pausedOn: "await-decision-window", stage: "awaiting-decision" })).toEqual({
      kind: "run-collect-and-plan",
    });
  });

  it("saute la collecte et calcule le plan si déjà collecté (ex. manuel)", () => {
    const plan = resolveCronDecisionPlan({ pausedOn: "await-plan-trigger", stage: "awaiting-plan" });
    expect(plan.kind).toBe("skip-collect-run-plan");
    if (plan.kind === "skip-collect-run-plan") {
      expect(plan.skipMessage).toMatch(/collecte déjà faite/);
      expect(plan.skipMessage).toMatch(/calcule le plan/);
    }
  });

  it("ignore tout si déjà en attente du go", () => {
    const plan = resolveCronDecisionPlan({ pausedOn: "await-go", stage: "awaiting-go" });
    expect(plan.kind).toBe("skip-all");
    if (plan.kind === "skip-all") {
      expect(plan.skipMessage).toMatch(/déjà avancées/);
      expect(plan.skipMessage).toMatch(/decisionCron ignoré/);
    }
  });

  it("ignore tout si terminé / annoncé", () => {
    expect(resolveCronDecisionPlan({ stage: "finished-announced" }).kind).toBe("skip-all");
  });

  it("ignore tout si sondage pas encore parti", () => {
    expect(resolveCronDecisionPlan({ stage: "not-started" }).kind).toBe("skip-all");
  });
});
