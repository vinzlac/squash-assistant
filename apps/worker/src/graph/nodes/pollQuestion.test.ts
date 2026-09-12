import { describe, expect, it } from "vitest";
import {
  SUBSTITUTE_VOLUNTEER_POLL_OPTION,
  buildClosureCancelMessage,
  buildClubClosedMessage,
  buildPollOptions,
  buildPollQuestion,
} from "./pollQuestion.js";

describe("buildPollOptions", () => {
  it("une heure candidate : heure + Non + prête-nom volontaire (ADR-017)", () => {
    expect(buildPollOptions(["18H45"])).toEqual(["18H45", "Non", SUBSTITUTE_VOLUNTEER_POLL_OPTION]);
  });

  it("plusieurs heures candidates : une option par heure + Non + prête-nom volontaire", () => {
    expect(buildPollOptions(["18H45", "19H30"])).toEqual([
      "18H45",
      "19H30",
      "Non",
      SUBSTITUTE_VOLUNTEER_POLL_OPTION,
    ]);
  });
});

describe("buildPollQuestion", () => {
  it("une seule heure candidate : question fermée classique", () => {
    const question = buildPollQuestion("2026-08-01", ["10H30"]);
    expect(question).toContain("10h30");
    expect(question).not.toContain("à quelle heure");
  });

  it("plusieurs heures candidates : question ouverte sur l'heure", () => {
    const question = buildPollQuestion("2026-07-21", ["18H45", "19H30"]);
    expect(question).toContain("à quelle heure");
    expect(question).toContain("18h45");
    expect(question).toContain("19h30");
  });
});

describe("buildClubClosedMessage", () => {
  it("ton informel, date, raison entre parenthèses, pas de sondage cette semaine", () => {
    expect(buildClubClosedMessage("2026-09-19", ["tournoi"])).toBe(
      "Hello la team ! Le PUC est fermé samedi 19 septembre (tournoi), donc pas de squash ce jour-là 😕 Pas de sondage cette semaine, on remet ça la semaine suivante 💪",
    );
  });

  it("sans libellé : pas de parenthèse", () => {
    expect(buildClubClosedMessage("2026-09-19", [null])).toBe(
      "Hello la team ! Le PUC est fermé samedi 19 septembre, donc pas de squash ce jour-là 😕 Pas de sondage cette semaine, on remet ça la semaine suivante 💪",
    );
  });

  it("plusieurs libellés : dédupliqués et joints par « / »", () => {
    expect(buildClubClosedMessage("2026-09-19", ["tournoi", "tournoi", "travaux"])).toContain("(tournoi / travaux)");
  });
});

describe("buildClosureCancelMessage", () => {
  it("sondage supprimé", () => {
    expect(buildClosureCancelMessage("2026-09-19", ["tournoi"], true)).toBe(
      "Hello la team ! Mauvaise nouvelle : le PUC est fermé samedi 19 septembre (tournoi), donc pas de squash ce jour-là 😕 J'ai supprimé le sondage, on remet ça la semaine prochaine 💪",
    );
  });

  it("sondage non supprimable", () => {
    expect(buildClosureCancelMessage("2026-09-19", ["tournoi"], false)).toBe(
      "Hello la team ! Mauvaise nouvelle : le PUC est fermé samedi 19 septembre (tournoi), donc pas de squash ce jour-là 😕 Ignorez le sondage du coup, on remet ça la semaine prochaine 💪",
    );
  });
});

describe("buildPollQuestion avec closedTimes", () => {
  it("ajoute la mention des heures fermées", () => {
    const q = buildPollQuestion("2026-08-15", ["19H30"], ["18H45"]);
    expect(q).toContain("19h30");
    expect(q).toContain("18h45");
    expect(q).toContain("puc fermé");
  });
});
