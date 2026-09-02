import { describe, expect, it } from "vitest";
import { resolvePlayerIdsInText } from "./formatWarning.js";

describe("resolvePlayerIdsInText", () => {
  const names = {
    "60e7777dbc53560027fe49ef": "Tin LAM",
    "60bf46402d842c0027a508d4": "Martin MERLOT",
    "60e23b69a78d1100206b808c": "Terence CHIARADIA",
  };

  it("remplace un id connu par le nom seul (pas de rappel de l'id)", () => {
    expect(
      resolvePlayerIdsInText("60e7777dbc53560027fe49ef : pas réinscrit(s) — réservation ignorée.", names),
    ).toBe("Tin LAM : pas réinscrit(s) — réservation ignorée.");
  });

  it("remplace toutes les occurrences, y compris dans un groupe joint par +", () => {
    expect(
      resolvePlayerIdsInText(
        "Groupe 60e23b69a78d1100206b808c+60e7777dbc53560027fe49ef+60bf46402d842c0027a508d4 : 0/3 round(s).",
        names,
      ),
    ).toBe("Groupe Terence CHIARADIA+Tin LAM+Martin MERLOT : 0/3 round(s).");
  });

  it("laisse tel quel un id absent de l'annuaire", () => {
    expect(resolvePlayerIdsInText("60ffffffffffffffffffffff : pas réinscrit(s).", names)).toBe(
      "60ffffffffffffffffffffff : pas réinscrit(s).",
    );
  });

  it("retourne le texte inchangé si l'annuaire est vide", () => {
    expect(resolvePlayerIdsInText("Effectif impair : 60bf46402d842c0027a508d4 intégré.", {})).toBe(
      "Effectif impair : 60bf46402d842c0027a508d4 intégré.",
    );
  });
});
