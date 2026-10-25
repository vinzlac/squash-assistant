import { describe, expect, it } from "vitest";
import type { Identities, RosterFinal, VoteState } from "@squash-assistant/db/rosterTypes";
import { applyMoves, initialRosters } from "./allocation.js";
import {
  buildFinalRosterMessage,
  buildProvisionalRosterMessage,
  rosterDisplayName,
  rosterFingerprint,
  rosterInscritsByTime,
} from "./rosterMessage.js";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "../graph/nodes/pollQuestion.js";

const CANDIDATES = ["9H00", "10H30"];
const TARGET = "2026-07-22";
const NAMES = ["Henry", "Stef", "Vinz", "Laurent", "Max", "Paul", "Hugo2", "Terence"];
const identities: Identities = Object.fromEntries(NAMES.map((n) => [`nom:${n}`, { userId: "u", name: n }]));
const displayName = (k: string) => rosterDisplayName(k, identities);
const vote = (option: string | null, lastAt: number) => ({ option, lastAt });

const planState: VoteState = {
  "nom:Henry": vote("9H00", 1),
  "nom:Stef": vote("9H00", 2),
  "nom:Vinz": vote("9H00", 3),
  "nom:Laurent": vote("9H00", 4),
  "nom:Max": vote("10H30", 5),
  "nom:Paul": vote("10H30", 6),
};

const final = (over: Partial<RosterFinal> = {}): RosterFinal => ({
  base: { tPlan: "t", state: planState, integratedEventIds: [] },
  hours: [],
  realBooking: false,
  title: "TITRE",
  courtsBlock: "COURTS",
  failuresNote: "",
  capacityNote: "",
  ...over,
});

describe("buildProvisionalRosterMessage", () => {
  it("CA-1 rendu provisoire", () => {
    const text = buildProvisionalRosterMessage({ targetDate: TARGET, candidateStartTimes: CANDIDATES, state: planState, identities });
    expect(text.split("\n")).toEqual([
      "📋 Inscrits — mercredi 22 juillet 🎾",
      "⏰ 9h (4) : Henry, Stef, Vinz, Laurent",
      "⏰ 10h30 (2) : Max, Paul",
      "Les courts arrivent bientôt 😉",
      "Pour te désister, retire ton vote dans le sondage 🙏",
    ]);
  });

  it("liste les prête-noms sur la ligne 🙏", () => {
    const state: VoteState = { ...planState, "nom:Hugo2": vote(SUBSTITUTE_VOLUNTEER_POLL_OPTION, 7), "nom:Terence": vote(SUBSTITUTE_VOLUNTEER_POLL_OPTION, 8) };
    const text = buildProvisionalRosterMessage({ targetDate: TARGET, candidateStartTimes: CANDIDATES, state, identities });
    expect(text).toContain("🙏 Merci à Hugo2 et Terence pour les prête-noms :)");
  });

  it("provisoire sans inscrit", () => {
    const state: VoteState = { "nom:Paul": vote(null, 1) };
    const text = buildProvisionalRosterMessage({ targetDate: TARGET, candidateStartTimes: CANDIDATES, state, identities });
    expect(text).toBe("📋 Inscrits — mercredi 22 juillet\nPersonne pour l'instant 😢");
  });
});

describe("buildFinalRosterMessage", () => {
  const hours = [{ time: "9H00", capacity: 4 }, { time: "10H30", capacity: 2 }];
  const caRosters = () =>
    applyMoves(
      initialRosters(hours, planState, displayName),
      [
        { key: "nom:Paul", option: null },
        { key: "nom:Hugo2", option: "9H00" },
        { key: "nom:Terence", option: "9H00" },
        { key: "nom:Henry", option: null },
      ],
      CANDIDATES,
    );

  it("CA-3 rendu définitif", () => {
    const text = buildFinalRosterMessage({ final: final({ failuresNote: "ECHEC", capacityNote: "CAP" }), targetDate: TARGET, rosters: caRosters(), identities, candidateStartTimes: CANDIDATES });
    expect(text).toContain("⏰ 9h (4/4) : Hugo2 (remplace Henry), Stef, Vinz, Laurent");
    expect(text).toContain("⏳ En attente 9h : Terence");
    expect(text).toContain("⏰ 10h30 (1/2) : Max — 1 place libre");
    expect(text).toBe(
      [
        "TITRE", "", `📅 ${TARGET}`, "", "COURTS", "",
        "⏰ 9h (4/4) : Hugo2 (remplace Henry), Stef, Vinz, Laurent",
        "⏳ En attente 9h : Terence",
        "⏰ 10h30 (1/2) : Max — 1 place libre",
        "ECHEC", "CAP", "",
        "Changer d'heure = repasser en attente si l'heure est pleine.",
        "Pour te désister, retire ton vote dans le sondage 🙏",
      ].join("\n"),
    );
  });

  it("heure sans inscrit : places libres au pluriel", () => {
    const rosters = initialRosters([{ time: "9H00", capacity: 2 }], {}, displayName);
    const text = buildFinalRosterMessage({ final: final(), targetDate: TARGET, rosters, identities, candidateStartTimes: CANDIDATES });
    expect(text).toContain("⏰ 9h (0/2) — 2 places libres");
  });

  it("heure plafond 0 avec attente → « pas de court réservé »", () => {
    const rosters = initialRosters([{ time: "9H00", capacity: 0 }], { "nom:Max": vote("9H00", 1) }, displayName);
    const text = buildFinalRosterMessage({ final: final(), targetDate: TARGET, rosters, identities, candidateStartTimes: CANDIDATES });
    expect(text).toContain("⏰ 9h : pas de court réservé");
    expect(text).toContain("⏳ En attente 9h : Max");
  });

  it("heure plafond 0 sans attente → absente", () => {
    const rosters = initialRosters([{ time: "9H00", capacity: 0 }], {}, displayName);
    const text = buildFinalRosterMessage({ final: final(), targetDate: TARGET, rosters, identities, candidateStartTimes: CANDIDATES });
    expect(text).not.toContain("9h");
  });
});

describe("rosterDisplayName", () => {
  it("jamais de téléphone ni de JID", () => {
    const ids: Identities = {
      "tel:+33612345678": { userId: null, name: "+33 6 12 34 56 78" },
      "jid:a@lid": { userId: null, name: "Léa" },
    };
    expect(rosterDisplayName("tel:+33612345678", ids)).toBe("un joueur");
    expect(rosterDisplayName("jid:x@lid", ids)).toBe("un joueur");
    expect(rosterDisplayName("jid:a@lid", ids)).toBe("Léa");
  });
});

describe("rosterInscritsByTime", () => {
  it("noms des inscrits par heure", () => {
    const rosters = initialRosters([{ time: "9H00", capacity: 2 }], planState, displayName);
    expect(rosterInscritsByTime(rosters, identities)).toEqual({ "9H00": ["Henry", "Stef"] });
  });
});

describe("rosterFingerprint", () => {
  it("empreinte stable", () => {
    expect(rosterFingerprint("abc")).toBe(rosterFingerprint("abc"));
    expect(rosterFingerprint("abc")).not.toBe(rosterFingerprint("abcd"));
    expect(rosterFingerprint("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("notes vides", () => {
  it("n'ajoute pas de ligne vide quand failuresNote et capacityNote sont vides", () => {
    const rosters = initialRosters([{ time: "9H00", capacity: 1 }], { "nom:Henry": planState["nom:Henry"] }, displayName);
    const text = buildFinalRosterMessage({ final: final(), targetDate: TARGET, rosters, identities, candidateStartTimes: CANDIDATES });
    expect(text).toContain("⏰ 9h (1/1) : Henry\n\nChanger d'heure");
  });
});
