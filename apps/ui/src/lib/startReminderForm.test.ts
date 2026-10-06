import { describe, expect, it } from "vitest";
import { parseStartReminderMinutes } from "./startReminderForm";

function form(value?: string): FormData {
  const f = new FormData();
  if (value !== undefined) f.set("startReminderMinutesBefore", value);
  return f;
}

describe("parseStartReminderMinutes", () => {
  it("valeur absente ou vide → 120", () => {
    expect(parseStartReminderMinutes(form())).toBe(120);
    expect(parseStartReminderMinutes(form(""))).toBe(120);
  });
  it("bornes incluses", () => {
    expect(parseStartReminderMinutes(form("30"))).toBe(30);
    expect(parseStartReminderMinutes(form("360"))).toBe(360);
  });
  it("hors bornes ou non entier → erreur explicite, pas de correction silencieuse", () => {
    for (const bad of ["29", "361", "90.5", "abc"]) {
      expect(() => parseStartReminderMinutes(form(bad))).toThrow(
        "Rappel avant le match : le délai doit être un nombre entier de minutes entre 30 et 360.",
      );
    }
  });
});
