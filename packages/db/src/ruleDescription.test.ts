import { describe, expect, it } from "vitest";
import { REAL_RULES } from "./fixtures/realRules.js";
import { describeRuleInFrench } from "./ruleDescription.js";

describe("describeRuleInFrench", () => {
  it("squashacademie-mardi : jour cible, sondage et décision J-7 avec leurs heures, priorité des courts", () => {
    const text = describeRuleInFrench(REAL_RULES["squashacademie-mardi"]!);
    expect(text).toContain("La réservation vise chaque mardi");
    expect(text).toContain("7 jour(s) avant, le mardi à 10:00");
    expect(text).toContain("7 jour(s) avant, le mardi à 21:30");
    expect(text).toContain("décalage aléatoire de ±10 minutes");
    expect(text).toContain("18H45, 19H30");
    expect(text).toContain("4, 3, 2, 1");
    expect(text).toContain("entre 2 et 3 joueurs");
    expect(text).toContain("3 court(s)");
    expect(text).toContain("2 créneau(x)");
    expect(text).toContain("minimum de joueurs par court (2");
  });

  it("squash-samedi-matin : jour cible samedi, sondage et décision J-4 (mardi)", () => {
    const text = describeRuleInFrench(REAL_RULES["squash-samedi-matin"]!, {
      playerNames: { "60bf2fdd1fd8d20020d2c8a7": "Vincent LACOSTE" },
    });
    expect(text).toContain("La réservation vise chaque samedi");
    expect(text).toContain("4 jour(s) avant, le mardi à 10:00");
    expect(text).toContain("4 jour(s) avant, le mardi à 21:30");
    expect(text).toContain("10H30");
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

  it("aucun prête-nom configuré : le dit explicitement, et mentionne le plafond de résas/jour", () => {
    const text = describeRuleInFrench(REAL_RULES["test-vincent-all"]!);
    expect(text).toContain("Aucun prête-nom n'est configuré");
    expect(text).toContain("Plafond de réservations par joueur et par jour : 2");
  });

  it("prête-noms configurés : listés par ordre de priorité, noms résolus", () => {
    const text = describeRuleInFrench(
      { ...REAL_RULES["test-vincent-all"]!, substituteBookers: ["60fc6be253b9530027a6b86c"], maxDailyReservationsPerPlayer: 3 },
      { playerNames: { "60fc6be253b9530027a6b86c": "Stéphane CHIBAH" } },
    );
    expect(text).toContain("Prête-noms utilisables en repli");
    expect(text).toContain("Stéphane CHIBAH");
    expect(text).toContain("Plafond de réservations par joueur et par jour : 3");
  });

  it("aucun joker configuré : le dit explicitement (l'échec reste un échec)", () => {
    const text = describeRuleInFrench(REAL_RULES["test-vincent-all"]!);
    expect(text).toContain("Aucun joker n'est configuré");
  });

  it("joker configuré : nom résolu et motifs de substitution décrits", () => {
    const text = describeRuleInFrench(
      { ...REAL_RULES["test-vincent-all"]!, jokerBookerId: "60fc6be253b9530027a6b86c" },
      { playerNames: { "60fc6be253b9530027a6b86c": "Joshua JACQUES-PHINERA" } },
    );
    expect(text).toContain("Joshua JACQUES-PHINERA");
    expect(text).toContain("pas réinscrit pour la saison");
    expect(text).toContain("en partenaire");
    expect(text).toContain("sans limite de nombre");
  });

  it("preferMinPlayersPerCourt=false : décrit le remplissage max direct, pas d'escalade", () => {
    const text = describeRuleInFrench({ ...REAL_RULES["squashacademie-mardi"]!, preferMinPlayersPerCourt: false });
    expect(text).toContain("remplissage privilégié est directement le nombre maximum de joueurs par court (3");
  });

  it("noms de groupes fournis en contexte : affichés à côté des identifiants bruts", () => {
    const text = describeRuleInFrench(REAL_RULES["squashacademie-mardi"]!, {
      whatsappGroupName: "La squashacadémie",
      resaSquashGroupName: "squash du mardi",
    });
    expect(text).toContain("La squashacadémie (33661825152-1464609988@g.us)");
    expect(text).toContain("squash du mardi (a534d3db-8e0e-446a-9536-bbfc82c29274)");
  });

  it("groupe de notification distinct : mentionné explicitement", () => {
    const text = describeRuleInFrench(
      {
        ...REAL_RULES["squash-samedi-matin"]!,
        reservationNotifyWhatsappGroupJid: "120363424956785709@g.us",
      },
      { reservationNotifyWhatsappGroupName: "Vincent All" },
    );
    expect(text).toContain("groupe distinct");
    expect(text).toContain("Vincent All");
    expect(text).toContain("120363424956785709@g.us");
  });

  it("pas de groupe de notification : annonce sur le groupe d'origine", () => {
    const text = describeRuleInFrench(REAL_RULES["squash-samedi-matin"]!);
    expect(text).toContain("même groupe que le sondage");
  });

  it("groupe de confirmation distinct : mentionné dans la phrase de confirmation, pas dans celle de l'annonce", () => {
    const text = describeRuleInFrench(
      {
        ...REAL_RULES["squash-samedi-matin"]!,
        confirmationNotifyWhatsappGroupJid: "120363424956785709@g.us",
      },
      { confirmationNotifyWhatsappGroupName: "Assistant resa squash" },
    );
    const confirmationSentence = text.split("\n").find((l) => l.startsWith("La confirmation WhatsApp"))!;
    expect(confirmationSentence).toContain("groupe distinct");
    expect(confirmationSentence).toContain("Assistant resa squash (120363424956785709@g.us)");
    const announceSentence = text.split("\n").find((l) => l.startsWith("L'annonce WhatsApp"))!;
    expect(announceSentence).not.toContain("120363424956785709@g.us");
  });

  it("pas de groupe de confirmation : confirmation sur le groupe d'origine, même si l'annonce est ailleurs", () => {
    const text = describeRuleInFrench({
      ...REAL_RULES["squash-samedi-matin"]!,
      reservationNotifyWhatsappGroupJid: "annonce-test@g.us",
    });
    const confirmationSentence = text.split("\n").find((l) => l.startsWith("La confirmation WhatsApp"))!;
    expect(confirmationSentence).toContain("groupe d'origine");
    expect(confirmationSentence).not.toContain("annonce-test@g.us");
  });

  it("flou horaire du sondage : mentionne la fenêtre en minutes", () => {
    const text = describeRuleInFrench({ ...REAL_RULES["squashacademie-mardi"]!, cronJitterWindowMinutes: 45 });
    expect(text).toContain("45 minute(s)");
  });

  it("flou horaire 0 : départ immédiat", () => {
    const text = describeRuleInFrench({ ...REAL_RULES["squashacademie-mardi"]!, cronJitterWindowMinutes: 0 });
    expect(text).toContain("sans flou horaire");
  });

  it("rappel avant le match activé : phrase avec le délai et le groupe de confirmation", () => {
    const text = describeRuleInFrench({ ...REAL_RULES["squashacademie-mardi"]!, startReminderEnabled: true, startReminderMinutesBefore: 120 });
    const sentence = text.split("\n").find((l) => l.startsWith("Le jour du match"))!;
    expect(sentence).toContain("2 h avant le premier créneau réservé");
    expect(sentence).toContain("±10 minutes");
    expect(sentence).toContain("même groupe que la confirmation");
  });

  it("rappel avant le match : 90 min → « 1 h 30 », 45 min → « 45 min »", () => {
    const base = REAL_RULES["squashacademie-mardi"]!;
    expect(describeRuleInFrench({ ...base, startReminderEnabled: true, startReminderMinutesBefore: 90 })).toContain("1 h 30 avant");
    expect(describeRuleInFrench({ ...base, startReminderEnabled: true, startReminderMinutesBefore: 45 })).toContain("45 min avant");
  });

  it("rappel activé mais décision le jour du match : signalé inactif", () => {
    const text = describeRuleInFrench({ ...REAL_RULES["squashacademie-mardi"]!, startReminderEnabled: true, decisionDaysBefore: 0 });
    expect(text).toContain("Le rappel avant le match est activé mais inactif : la décision a lieu le jour du match.");
  });

  it("rappel désactivé : aucune phrase", () => {
    const text = describeRuleInFrench({ ...REAL_RULES["squashacademie-mardi"]!, startReminderEnabled: false });
    expect(text).not.toContain("Le jour du match");
    expect(text).not.toContain("rappel avant le match");
  });
});
