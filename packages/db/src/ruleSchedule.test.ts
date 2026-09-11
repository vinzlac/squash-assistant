import { describe, expect, it } from "vitest";
import { deriveCrons, triggerWeekday, validateRuleSchedule, type RuleSchedule } from "./ruleSchedule.js";

const mardi: RuleSchedule = {
  targetWeekday: 2,
  pollDaysBefore: 7,
  pollTime: "10:00",
  decisionDaysBefore: 7,
  decisionTime: "21:30",
};

describe("triggerWeekday", () => {
  it("mardi − 7 = mardi (squashacademie-mardi)", () => {
    expect(triggerWeekday(2, 7)).toBe(2);
  });
  it("samedi − 4 = mardi (squash-samedi-matin)", () => {
    expect(triggerWeekday(6, 4)).toBe(2);
  });
  it("dimanche − 1 = samedi (wrap-around négatif)", () => {
    expect(triggerWeekday(0, 1)).toBe(6);
  });
  it("mardi − 9 = dimanche (plus d'une semaine avant)", () => {
    expect(triggerWeekday(2, 9)).toBe(0);
  });
  it("M = 0 → le jour cible lui-même", () => {
    expect(triggerWeekday(3, 0)).toBe(3);
  });
});

describe("deriveCrons", () => {
  it("reproduit les crons historiques de squashacademie-mardi", () => {
    expect(deriveCrons(mardi)).toEqual({ pollCron: "0 10 * * 2", decisionCron: "30 21 * * 2" });
  });
  it("reproduit les crons historiques de squash-samedi-matin (N = M = 4)", () => {
    expect(
      deriveCrons({ targetWeekday: 6, pollDaysBefore: 4, pollTime: "10:00", decisionDaysBefore: 4, decisionTime: "21:30" }),
    ).toEqual({ pollCron: "0 10 * * 2", decisionCron: "30 21 * * 2" });
  });
  it("N ≠ M : sondage dimanche J-9, décision mardi J-7", () => {
    expect(deriveCrons({ ...mardi, pollDaysBefore: 9, decisionDaysBefore: 7 })).toEqual({
      pollCron: "0 10 * * 0",
      decisionCron: "30 21 * * 2",
    });
  });
  it("ne perd pas le zéro initial des minutes (09:05 → « 5 9 »)", () => {
    expect(deriveCrons({ ...mardi, pollTime: "09:05" }).pollCron).toBe("5 9 * * 2");
  });
});

describe("validateRuleSchedule", () => {
  it("accepte une règle cohérente", () => {
    expect(validateRuleSchedule(mardi)).toEqual([]);
  });
  it("refuse M > N", () => {
    expect(validateRuleSchedule({ ...mardi, decisionDaysBefore: 8 })).toContain(
      "La décision (8 j avant) ne peut pas précéder le sondage (7 j avant).",
    );
  });
  it("refuse N < 1", () => {
    expect(validateRuleSchedule({ ...mardi, pollDaysBefore: 0, decisionDaysBefore: 0 })).toContain(
      "Le sondage doit être lancé au moins 1 jour avant la date cible.",
    );
  });
  it("refuse M = N avec l'heure de décision avant celle du sondage", () => {
    expect(validateRuleSchedule({ ...mardi, decisionTime: "09:00" })).toContain(
      "Même jour : l'heure de décision (09:00) doit être après l'heure du sondage (10:00).",
    );
  });
  it("accepte M = N avec l'heure de décision après celle du sondage", () => {
    expect(validateRuleSchedule({ ...mardi, decisionTime: "10:01" })).toEqual([]);
  });
  it("refuse un jour cible hors 0–6 et une heure mal formée", () => {
    const errors = validateRuleSchedule({ ...mardi, targetWeekday: 7, pollTime: "10h00" });
    expect(errors).toContain("Jour cible invalide : 7 (attendu 0 = dimanche … 6 = samedi).");
    expect(errors).toContain("Heure du sondage invalide : « 10h00 » (attendu HH:MM).");
  });
});
