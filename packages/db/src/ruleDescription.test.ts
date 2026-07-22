import { describe, expect, it } from "vitest";
import { REAL_RULES } from "./fixtures/realRules.js";
import { describeRuleInFrench } from "./ruleDescription.js";

describe("describeRuleInFrench", () => {
  it("squashacademie-mardi : jour/heure du sondage, heures candidates, décalage J+7, priorité des courts", () => {
    const text = describeRuleInFrench(REAL_RULES["squashacademie-mardi"]!);
    expect(text).toContain("mardi à 10H00");
    expect(text).toContain("18H45, 19H30");
    expect(text).toContain("mardi à 21H30");
    expect(text).toContain("J+7");
    expect(text).toContain("4, 3, 2, 1");
    expect(text).toContain("entre 2 et 3 joueurs");
    expect(text).toContain("3 court(s)");
    expect(text).toContain("2 créneau(x)");
    expect(text).toContain("MINIMUM de joueurs par court");
  });

  it("squash-samedi-matin : décalage J+4, une seule heure candidate, 1 seul réservataire prioritaire", () => {
    const text = describeRuleInFrench(REAL_RULES["squash-samedi-matin"]!, {
      playerNames: { "60bf2fdd1fd8d20020d2c8a7": "Vincent LACOSTE" },
    });
    expect(text).toContain("10H30");
    expect(text).toContain("J+4");
    expect(text).toContain("Vincent LACOSTE");
    expect(text).toContain("1, 2, 3, 4");
  });

  it("test-vincent-all : 1 seul court max, remplissage 2-2 (pas d'escalade possible), fenêtre 3h", () => {
    const text = describeRuleInFrench(REAL_RULES["test-vincent-all"]!);
    expect(text).toContain("entre 2 et 2 joueurs");
    expect(text).toContain("1 court(s)");
    expect(text).toContain("jusqu'à 3h après la 1ère heure candidate");
  });

  it("règle désactivée : le mentionne explicitement", () => {
    const text = describeRuleInFrench(REAL_RULES["squashacademie-mardi"]!);
    expect(text).toContain("actuellement désactivée");
  });

  it("règle active : le mentionne explicitement", () => {
    const text = describeRuleInFrench({ ...REAL_RULES["squashacademie-mardi"]!, enabled: true });
    expect(text).toContain("actuellement active");
  });

  it("aucun réservataire prioritaire : le dit explicitement plutôt que de lister une liste vide", () => {
    const text = describeRuleInFrench({ ...REAL_RULES["test-vincent-all"]!, priorityBookers: [] });
    expect(text).toContain("Aucun réservataire prioritaire");
  });

  it("preferMinPlayersPerCourt=false : décrit le remplissage max direct, pas d'escalade", () => {
    const text = describeRuleInFrench({ ...REAL_RULES["squashacademie-mardi"]!, preferMinPlayersPerCourt: false });
    expect(text).toContain("remplissage privilégié est directement le nombre MAXIMUM");
  });

  it("cron non standard : retombe sur le cron brut sans planter", () => {
    const text = describeRuleInFrench({ ...REAL_RULES["test-vincent-all"]!, pollCron: "*/15 * * * *" });
    expect(text).toContain("*/15 * * * *");
  });

  it("noms de groupes fournis en contexte : affichés à côté des identifiants bruts", () => {
    const text = describeRuleInFrench(REAL_RULES["squashacademie-mardi"]!, {
      whatsappGroupName: "La squashacadémie",
      resaSquashGroupName: "squash du mardi",
    });
    expect(text).toContain("La squashacadémie (33661825152-1464609988@g.us)");
    expect(text).toContain("squash du mardi (a534d3db-8e0e-446a-9536-bbfc82c29274)");
  });
});
