import { describe, expect, it } from "vitest";
import {
  SUBSTITUTE_VOLUNTEER_POLL_OPTION,
  buildClosureCancelMessage,
  buildClubClosedMessage,
  buildPollOptions,
  buildPollQuestion,
  formatPollClosureDeadline,
  pollAnnouncedClosure,
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

describe("clôture du sondage (spec 2026-10-09 §1.1)", () => {
  // samedi 10 octobre 2026, Paris = UTC+2
  it("date cible − decisionDaysBefore, heure decisionTime au format « 9h »", () => {
    expect(formatPollClosureDeadline("2026-10-10", 5, "09:00", new Date("2026-10-03T08:00:00Z"))).toBe("lundi 5 octobre à 9h");
    expect(formatPollClosureDeadline("2026-10-10", 5, "21:30", new Date("2026-10-04T08:00:00Z"))).toBe("lundi 5 octobre à 21h30");
  });

  it("decisionDaysBefore = 0 : le jour affiché est le jour du match", () => {
    expect(formatPollClosureDeadline("2026-10-10", 0, "08:00", new Date("2026-10-09T10:00:00Z"))).toBe("samedi 10 octobre à 8h");
  });

  it("clôture déjà passée à l'envoi : mention omise (null)", () => {
    expect(formatPollClosureDeadline("2026-10-10", 5, "09:00", new Date("2026-10-05T07:00:00Z"))).toBeNull(); // 9h00 Paris
    expect(formatPollClosureDeadline("2026-10-10", 5, "09:00", new Date("2026-10-05T06:59:00Z"))).toBe("lundi 5 octobre à 9h");
  });

  it("clôture à plus de 48 h de l'envoi (garde-fou de suppression) : mention omise", () => {
    // clôture lundi 5 octobre 9h Paris = 07:00Z
    expect(formatPollClosureDeadline("2026-10-10", 5, "09:00", new Date("2026-10-03T08:00:00Z"))).toBe("lundi 5 octobre à 9h"); // 47 h
    expect(formatPollClosureDeadline("2026-10-10", 5, "09:00", new Date("2026-10-03T07:00:00Z"))).toBeNull(); // 48 h pile (marge)
    expect(formatPollClosureDeadline("2026-10-10", 5, "09:00", new Date("2026-10-03T06:00:00Z"))).toBeNull(); // 49 h
  });

  it("marge de 15 min (la collecte mesure l'âge un peu après l'envoi) : mention jusqu'à 47 h 45 avant la clôture", () => {
    // clôture lundi 5 octobre 9h Paris = 07:00Z
    expect(formatPollClosureDeadline("2026-10-10", 5, "09:00", new Date("2026-10-03T07:16:00Z"))).toBe("lundi 5 octobre à 9h"); // 47 h 44
    expect(formatPollClosureDeadline("2026-10-10", 5, "09:00", new Date("2026-10-03T07:14:00Z"))).toBeNull(); // 47 h 46
  });

  it("écart de 48 h calculé en temps réel, changement d'heure compris (fin de l'heure d'été le 25 octobre)", () => {
    // clôture lundi 26 octobre 9h Paris = 08:00Z (UTC+1) ; envoi le 24 à 07:30Z → 48 h 30 réelles
    expect(formatPollClosureDeadline("2026-10-26", 0, "09:00", new Date("2026-10-24T07:30:00Z"))).toBeNull();
    expect(formatPollClosureDeadline("2026-10-26", 0, "09:00", new Date("2026-10-24T08:30:00Z"))).toBe("lundi 26 octobre à 9h");
  });

  it("question : la clôture vient en dernier, après « puc fermé »", () => {
    expect(buildPollQuestion("2026-10-10", ["10H30"], [], "lundi 5 octobre à 9h")).toBe(
      "Squash samedi 10 octobre à 10h30 ? (réponses jusqu'au lundi 5 octobre à 9h)",
    );
    expect(buildPollQuestion("2026-10-10", ["10H30"], ["9H45"], "lundi 5 octobre à 9h")).toBe(
      "Squash samedi 10 octobre à 10h30 ? (9h45 : puc fermé) (réponses jusqu'au lundi 5 octobre à 9h)",
    );
    expect(buildPollQuestion("2026-10-10", ["10H30"], [], null)).toBe("Squash samedi 10 octobre à 10h30 ?");
  });

  it("pollAnnouncedClosure : vrai seulement pour un sondage qui annonçait sa clôture", () => {
    expect(pollAnnouncedClosure(buildPollQuestion("2026-10-10", ["10H30"], [], "lundi 5 octobre à 9h"))).toBe(true);
    expect(pollAnnouncedClosure("Squash samedi 10 octobre à 10h30 ?")).toBe(false); // ancien sondage ou mention omise
    expect(pollAnnouncedClosure(undefined)).toBe(false); // pas d'événement poll
  });
});
