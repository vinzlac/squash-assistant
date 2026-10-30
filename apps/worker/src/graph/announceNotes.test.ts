import { describe, expect, it } from "vitest";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "./nodes/pollQuestion.js";
import { buildAnnounceNotes, buildShortageNote } from "./announceNotes.js";
import type { ReservationFailure, UnresolvedVoter } from "./state.js";

const failure = (overrides: Partial<ReservationFailure> = {}): ReservationFailure => ({
  sessionId: "s1",
  court: 3,
  slotTime: "18H45",
  slotEndTime: "19H30",
  userId: "a",
  partnerId: "joker",
  reason: "PLAYER_BOOKING_LIMIT_REACHED",
  message: "Joshua a utilisé tous ses crédits.",
  rawError: "raw",
  ...overrides,
});
const voter = (option: string): UnresolvedVoter => ({ name: "Robin", phone: null, option });

describe("buildShortageNote", () => {
  it("rien à dire quand aucun créneau n'est perdu", () => {
    expect(buildShortageNote({ hasShortfall: false, unregisteredCount: 1, missingSubstituteCount: 0 })).toBe("");
  });

  it("non inscrits et prête-noms manquants, avec les nombres", () => {
    expect(buildShortageNote({ hasShortfall: true, unregisteredCount: 1, missingSubstituteCount: 2 })).toBe(
      "\n\n⚠️ Tous les créneaux n'ont pas pu être réservés par manque de joueurs :\n" +
        "• 1 joueur non inscrit\n" +
        "• il aurait fallu 2 prête-noms de plus pour réserver 2 créneaux de plus",
    );
  });

  it("accorde le pluriel des non inscrits", () => {
    expect(buildShortageNote({ hasShortfall: true, unregisteredCount: 2, missingSubstituteCount: 0 })).toContain(
      "• 2 joueurs non inscrits",
    );
  });

  it("créneau perdu sans cause de manque de joueurs connue : phrase neutre", () => {
    expect(buildShortageNote({ hasShortfall: true, unregisteredCount: 0, missingSubstituteCount: 0 })).toBe(
      "\n\n⚠️ Tous les créneaux n'ont pas pu être réservés.",
    );
  });
});

describe("buildAnnounceNotes", () => {
  const base = {
    failures: [failure(), failure({ sessionId: "s2" })],
    unresolvedVoters: [voter("18H45"), voter(SUBSTITUTE_VOLUNTEER_POLL_OPTION)],
    unplacedPlayerCount: 2,
    failuresBlock: "\n\n⚠️ Non réservé :\n• détail",
  };

  it("groupe des joueurs : uniquement la raison du manque, sans détail ni compteur", () => {
    const notes = buildAnnounceNotes({ ...base, toPlayersGroup: true });
    expect(notes.failuresNote).toBe("");
    expect(notes.capacityNote).toContain("• 1 joueur non inscrit");
    expect(notes.capacityNote).toContain("il aurait fallu 2 prête-noms de plus");
    expect(notes.capacityNote).not.toContain("2 joueur(s)");
  });

  it("un prête-nom volontaire non identifié n'est pas un joueur non inscrit", () => {
    const notes = buildAnnounceNotes({
      ...base,
      toPlayersGroup: true,
      unresolvedVoters: [voter(SUBSTITUTE_VOLUNTEER_POLL_OPTION)],
    });
    expect(notes.capacityNote).not.toContain("non inscrit");
  });

  it("refus d'une autre nature (créneau déjà pris) : pas compté comme prête-nom manquant", () => {
    const notes = buildAnnounceNotes({
      ...base,
      toPlayersGroup: true,
      failures: [failure({ reason: "SLOT_ALREADY_BOOKED" })],
      unresolvedVoters: [],
    });
    expect(notes.capacityNote).toBe("\n\n⚠️ Tous les créneaux n'ont pas pu être réservés.");
  });

  it("autre groupe (test) : garde le détail par créneau et le compteur de joueurs", () => {
    const notes = buildAnnounceNotes({ ...base, toPlayersGroup: false });
    expect(notes.failuresNote).toBe(base.failuresBlock);
    expect(notes.capacityNote).toContain("par manque de joueurs");
    expect(notes.capacityNote).toContain("⚠️ 2 joueur(s) n'ont pas pu être réservé(s) cette semaine.");
  });

  it("aucun créneau perdu : aucune note", () => {
    const notes = buildAnnounceNotes({
      toPlayersGroup: true,
      failures: [],
      unresolvedVoters: [voter("18H45")],
      unplacedPlayerCount: 0,
      failuresBlock: "",
    });
    expect(notes).toEqual({ failuresNote: "", capacityNote: "" });
  });
});
