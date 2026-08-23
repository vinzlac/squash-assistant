import { describe, expect, it } from "vitest";
import bookingRules from "../../../../packages/db/seeds/booking-rules.seed.json" with { type: "json" };
import type { BookingRule } from "@squash-assistant/db/schema";
import { buildGroupBookingPlanParams } from "./buildGroupBookingPlanParams.js";

const rules = bookingRules as BookingRule[];

function ruleById(id: string): BookingRule {
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new Error(`Règle "${id}" introuvable dans booking-rules.json`);
  return rule;
}

describe("buildGroupBookingPlanParams", () => {
  it("squashacademie-mardi : Martin et Vincent réservataires prioritaires", () => {
    const rule = ruleById("squashacademie-mardi");
    const confirmed = ["user-tin", "60e23b69a78d1100206b808c", "60bf2fdd1fd8d20020d2c8a7"];
    const params = buildGroupBookingPlanParams(rule, confirmed, "2026-07-21", "18H45");

    expect(params.groupId).toBe(rule.resaSquashGroupId);
    expect(params.onDate).toBe("2026-07-21");
    expect(params.slotsPerPlayer).toBe(2);
    expect(params.startTime).toBe("18H45");
    expect(params.maxCourts).toBe(rule.maxCourtsPerSlot);
    expect(params.preferMinPlayersPerCourt).toBe(rule.preferMinPlayersPerCourt);
    expect(params.courtPriority).toEqual(rule.courtPriority);
    expect(params.maxDailyReservationsPerPlayer).toBe(rule.maxDailyReservationsPerPlayer);
    // priorityBookers = [Vincent, Martin] : Vincent en tête (réservataire de la 1ère
    // paire) ; Martin intercalé après un non-prioritaire pour rester réservataire
    // d'une paire distincte (donc d'un court distinct) plutôt que d'être apparié
    // avec Vincent sur le même court.
    expect(params.expectedPlayerIds[0]).toBe("60bf2fdd1fd8d20020d2c8a7");
    const vincentIndex = params.expectedPlayerIds.indexOf("60bf2fdd1fd8d20020d2c8a7");
    const martinIndex = params.expectedPlayerIds.indexOf("60e23b69a78d1100206b808c");
    expect(Math.floor(vincentIndex / 2)).not.toBe(Math.floor(martinIndex / 2));
    expect(params.expectedPlayerIds).toContain("user-tin");
  });

  it("exclut de substitutePlayerIds les prête-noms déjà confirmés ou déjà utilisés ce jour-là", () => {
    const rule: BookingRule = { ...ruleById("squash-samedi-matin"), substituteBookers: ["sub-a", "sub-b", "sub-c"] };
    const confirmed = ["user-x", "sub-b"];
    const usedTodayIds = new Set(["sub-c"]);

    const params = buildGroupBookingPlanParams(rule, confirmed, "2026-07-18", "10H30", undefined, usedTodayIds);

    expect(params.substitutePlayerIds).toEqual(["sub-a"]);
  });

  it("priorise les prête-noms volontaires du sondage avant les substituteBookers par défaut", () => {
    const rule: BookingRule = { ...ruleById("squash-samedi-matin"), substituteBookers: ["default-a", "default-b"] };

    const params = buildGroupBookingPlanParams(
      rule,
      ["user-x", "user-y"],
      "2026-07-18",
      "10H30",
      undefined,
      new Set(),
      ["volunteer-1", "volunteer-2"],
    );

    expect(params.substitutePlayerIds).toEqual(["volunteer-1", "volunteer-2", "default-a", "default-b"]);
  });

  it("preferMinPlayersPerCourtOverride écrase rule.preferMinPlayersPerCourt", () => {
    const rule = ruleById("squashacademie-mardi");
    const params = buildGroupBookingPlanParams(rule, ["user-x", "user-y"], "2026-07-21", "18H45", false);
    expect(params.preferMinPlayersPerCourt).toBe(false);
  });
});
