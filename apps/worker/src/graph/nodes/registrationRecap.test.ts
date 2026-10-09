import { describe, expect, it } from "vitest";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "./pollQuestion.js";
import { buildRegistrationRecapMessage, type RegistrationRecapInput } from "./registrationRecap.js";

const names = { u1: "Hugo MERCIER", u2: "Vincent LACOSTE", u3: "Gaëtan COATANROCH", u4: "Martin MERLOT", u5: "Julie DURAND" };

function input(overrides: Partial<RegistrationRecapInput> = {}): RegistrationRecapInput {
  return {
    targetDate: "2026-10-10",
    candidateStartTimes: ["10H30"],
    confirmedPlayerIdsByTime: { "10H30": ["u1", "u2", "u3", "u4"] },
    volunteerSubstituteIds: [],
    unresolvedVoters: [],
    voterNames: names,
    ...overrides,
  };
}

describe("buildRegistrationRecapMessage (spec 2026-10-09 §2.1)", () => {
  it("cas du job 04578758 : une heure, deux prête-noms non identifiés remerciés par leur nom WhatsApp", () => {
    const text = buildRegistrationRecapMessage(
      input({
        unresolvedVoters: [
          { name: "Thomas LECCIA", phone: "+33686870364", option: SUBSTITUTE_VOLUNTEER_POLL_OPTION },
          { name: "Vince", phone: "+33663892186", option: SUBSTITUTE_VOLUNTEER_POLL_OPTION },
        ],
      }),
    );
    expect(text).toBe(
      "🔒 Inscriptions closes — samedi 10 octobre 🎾\n" +
        "⏰ 10h30 (4) : Hugo MERCIER, Vincent LACOSTE, Gaëtan COATANROCH, Martin MERLOT\n" +
        "🙏 Merci à Thomas LECCIA et Vince pour les prête-noms :)\n" +
        "Les courts arrivent bientôt 😉",
    );
  });

  it("plusieurs heures (seules celles avec inscrits), un seul prête-nom identifié, votant non identifié compté à son heure", () => {
    const text = buildRegistrationRecapMessage(
      input({
        candidateStartTimes: ["9H45", "10H30", "11H15"],
        confirmedPlayerIdsByTime: { "9H45": ["u1", "u2"], "10H30": [], "11H15": ["u3"] },
        volunteerSubstituteIds: ["u5"],
        unresolvedVoters: [{ name: "Henry", phone: null, option: "11H15" }],
      }),
    );
    expect(text).toBe(
      "🔒 Inscriptions closes — samedi 10 octobre 🎾\n" +
        "⏰ 9h45 (2) : Hugo MERCIER, Vincent LACOSTE\n" +
        "⏰ 11h15 (2) : Gaëtan COATANROCH, Henry\n" +
        "🙏 Merci à Julie DURAND pour le prête-nom :)\n" +
        "Les courts arrivent bientôt 😉",
    );
  });

  it("trois prête-noms : « A, B et C »", () => {
    const text = buildRegistrationRecapMessage(input({ volunteerSubstituteIds: ["u5"], unresolvedVoters: [
      { name: "Thomas", phone: null, option: SUBSTITUTE_VOLUNTEER_POLL_OPTION },
      { name: "Vince", phone: null, option: SUBSTITUTE_VOLUNTEER_POLL_OPTION },
    ] }));
    expect(text).toContain("🙏 Merci à Julie DURAND, Thomas et Vince pour les prête-noms :)");
  });

  it("aucun inscrit : message court, pas de ligne sur les courts", () => {
    const text = buildRegistrationRecapMessage(input({ confirmedPlayerIdsByTime: { "10H30": [] }, volunteerSubstituteIds: ["u5"] }));
    expect(text).toBe("🔒 Inscriptions closes — samedi 10 octobre\nPersonne cette semaine 😢");
  });

  it("nom manquant dans voterNames : « un joueur », jamais l'id resa-squash", () => {
    const text = buildRegistrationRecapMessage(
      input({ confirmedPlayerIdsByTime: { "10H30": ["u1", "60be7781b884160020172c3a"] }, volunteerSubstituteIds: ["u-sans-nom"] }),
    );
    expect(text).toContain("⏰ 10h30 (2) : Hugo MERCIER, un joueur");
    expect(text).toContain("🙏 Merci à un joueur pour le prête-nom :)");
    expect(text).not.toContain("60be7781b884160020172c3a");
    expect(text).not.toContain("u-sans-nom");
  });

  it("aucun ⚠️ ni téléphone côté WhatsApp", () => {
    const text = buildRegistrationRecapMessage(
      input({ unresolvedVoters: [{ name: "Vince", phone: "+33663892186", option: "10H30" }] }),
    );
    expect(text).not.toContain("⚠️");
    expect(text).not.toContain("+33");
  });
});

describe("buildRegistrationRecapMessage — jamais de téléphone ni de JID sur WhatsApp", () => {
  const LEAKY_NAMES = ["33612345678", "+33 6 12 34 56 78", "123456@lid", "33612345678@s.whatsapp.net", "", "   "];

  it.each(LEAKY_NAMES)("nom non identifié %j : « un joueur » à son heure", (name) => {
    const text = buildRegistrationRecapMessage(
      input({ confirmedPlayerIdsByTime: { "10H30": ["u1"] }, unresolvedVoters: [{ name, phone: "+33612345678", option: "10H30" }] }),
    );
    expect(text).toContain("⏰ 10h30 (2) : Hugo MERCIER, un joueur");
    expect(text).not.toMatch(/\d{6,}|@/);
  });

  it.each(LEAKY_NAMES)("prête-nom non identifié %j : « un joueur » dans les remerciements", (name) => {
    const text = buildRegistrationRecapMessage(
      input({ unresolvedVoters: [{ name, phone: "+33612345678", option: SUBSTITUTE_VOLUNTEER_POLL_OPTION }] }),
    );
    expect(text).toContain("🙏 Merci à un joueur pour le prête-nom :)");
    expect(text).not.toMatch(/\d{6,}|@/);
  });

  it("un vrai nom reste inchangé", () => {
    const text = buildRegistrationRecapMessage(
      input({ unresolvedVoters: [{ name: "Vince", phone: "+33663892186", option: "10H30" }] }),
    );
    expect(text).toContain("Hugo MERCIER, Vincent LACOSTE, Gaëtan COATANROCH, Martin MERLOT, Vince");
  });
});
