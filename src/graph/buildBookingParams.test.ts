import { describe, expect, it } from "vitest";
import bookingRules from "../../seeds/booking-rules.seed.json" with { type: "json" };
import type { BookingRule } from "../config.js";
import { buildPlanGroupBookingsParams } from "./buildBookingParams.js";

const rules = bookingRules as BookingRule[];

function ruleById(id: string): BookingRule {
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new Error(`Règle "${id}" introuvable dans booking-rules.json`);
  return rule;
}

describe("buildPlanGroupBookingsParams — les 3 règles réelles", () => {
  it("squashacademie-mardi : Martin et Vincent réservataires prioritaires", () => {
    const rule = ruleById("squashacademie-mardi");
    const confirmed = ["user-tin", "60e23b69a78d1100206b808c", "60bf2fdd1fd8d20020d2c8a7"];
    const params = buildPlanGroupBookingsParams(rule, confirmed, "2026-07-21");

    expect(params.groupId).toBe(rule.resaSquashGroupId);
    expect(params.onDate).toBe("2026-07-21");
    expect(params.slotsPerPlayer).toBe(2);
    expect(params.dryRun).toBe(true);
    // priorityBookers = [Vincent, Martin] → dans cet ordre en tête, même si Vincent a répondu en dernier.
    expect(params.expectedPlayerIds.slice(0, 2)).toEqual(["60bf2fdd1fd8d20020d2c8a7", "60e23b69a78d1100206b808c"]);
    expect(params.expectedPlayerIds).toContain("user-tin");
  });

  it("squash-samedi-matin : Vincent réservataire prioritaire", () => {
    const rule = ruleById("squash-samedi-matin");
    const confirmed = ["user-x", "60bf2fdd1fd8d20020d2c8a7", "user-y"];
    const params = buildPlanGroupBookingsParams(rule, confirmed, "2026-07-18");

    expect(params.groupId).toBe(rule.resaSquashGroupId);
    expect(params.slotsPerPlayer).toBe(2);
    expect(params.expectedPlayerIds[0]).toBe("60bf2fdd1fd8d20020d2c8a7");
  });

  it("test-vincent-all : groupe de test, mêmes garanties", () => {
    const rule = ruleById("test-vincent-all");
    const confirmed = ["60bf2fdd1fd8d20020d2c8a7", "user-z"];
    const params = buildPlanGroupBookingsParams(rule, confirmed, "2026-07-14");

    expect(params.groupId).toBe(rule.resaSquashGroupId);
    expect(params.expectedPlayerIds).toEqual(["60bf2fdd1fd8d20020d2c8a7", "user-z"]);
  });

  it("ne modifie jamais dryRun à false, même si la règle ne le précise pas explicitement", () => {
    for (const rule of rules) {
      const params = buildPlanGroupBookingsParams(rule, [], "2026-07-14");
      expect(params.dryRun).toBe(true);
    }
  });
});
