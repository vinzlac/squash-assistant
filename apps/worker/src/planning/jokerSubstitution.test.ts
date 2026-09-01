import { describe, expect, it } from "vitest";
import {
  blamedPlayerIds,
  formatSubstitution,
  isSubstitutableReason,
  JokerAvailability,
  substitutionCandidates,
} from "./jokerSubstitution.js";

const JOKER = "joshua-jacques-phinera";
const A = "player-a";
const B = "player-b";

describe("isSubstitutableReason", () => {
  it("accepte les refus imputables à un joueur", () => {
    expect(isSubstitutableReason("PLAYER_NOT_REGISTERED")).toBe(true);
    expect(isSubstitutableReason("PLAYER_BOOKING_LIMIT_REACHED")).toBe(true);
  });

  it("refuse les autres causes — changer de nom n'y changerait rien", () => {
    expect(isSubstitutableReason("SLOT_ALREADY_BOOKED")).toBe(false);
    expect(isSubstitutableReason("TEAMR_BOOKING_REJECTED")).toBe(false);
    expect(isSubstitutableReason(null)).toBe(false);
    expect(isSubstitutableReason(undefined)).toBe(false);
  });
});

describe("blamedPlayerIds", () => {
  it("extrait les joueurs désignés par resa-squash", () => {
    expect(blamedPlayerIds({ players: [{ userId: A, displayName: "A" }] })).toEqual([A]);
  });

  it("tolère un détail absent ou d'une autre forme (refus de quota TeamR)", () => {
    expect(blamedPlayerIds(undefined)).toEqual([]);
    expect(blamedPlayerIds({ teamr: { message: "no credits" } })).toEqual([]);
    expect(blamedPlayerIds({ players: [{}, { userId: 42 }] })).toEqual([]);
  });
});

describe("substitutionCandidates", () => {
  it("ne tente que le joueur désigné par resa-squash", () => {
    expect(
      substitutionCandidates({ userId: A, partnerId: B, jokerBookerId: JOKER, blamedIds: [B] }),
    ).toEqual([{ replaced: B, userId: A, partnerId: JOKER }]);
  });

  it("sans joueur désigné (quota TeamR) : tente le partenaire puis le titulaire", () => {
    expect(
      substitutionCandidates({ userId: A, partnerId: B, jokerBookerId: JOKER, blamedIds: [] }),
    ).toEqual([
      { replaced: B, userId: A, partnerId: JOKER },
      { replaced: A, userId: JOKER, partnerId: B },
    ]);
  });

  it("ne remplace jamais les deux noms à la fois", () => {
    const candidates = substitutionCandidates({
      userId: A,
      partnerId: B,
      jokerBookerId: JOKER,
      blamedIds: [A, B],
    });
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect([c.userId, c.partnerId].filter((id) => id === JOKER)).toHaveLength(1);
    }
  });

  it("ne propose rien sans joker configuré", () => {
    expect(
      substitutionCandidates({ userId: A, partnerId: B, jokerBookerId: null, blamedIds: [A] }),
    ).toEqual([]);
  });

  it("ne propose rien si le joker est déjà sur la ligne refusée", () => {
    expect(
      substitutionCandidates({ userId: JOKER, partnerId: B, jokerBookerId: JOKER, blamedIds: [] }),
    ).toEqual([]);
  });
});

describe("JokerAvailability", () => {
  it("libère le joker d'un créneau à l'autre mais pas deux fois au même horaire", () => {
    const joker = new JokerAvailability(JOKER);
    expect(joker.isAvailableAt("18H45")).toBe(true);
    joker.markUsedAt("18H45");
    expect(joker.isAvailableAt("18H45")).toBe(false);
    expect(joker.isAvailableAt("19H30")).toBe(true);
  });

  it("n'est jamais disponible sans joker configuré", () => {
    expect(new JokerAvailability(null).isAvailableAt("18H45")).toBe(false);
  });
});

describe("formatSubstitution", () => {
  it("nomme le motif du remplacement", () => {
    const names: Record<string, string> = { [A]: "Alice Martin", [JOKER]: "Joshua JACQUES-PHINERA" };
    const line = formatSubstitution(
      { sessionId: "s1", slotTime: "18H45", replacedUserId: A, jokerBookerId: JOKER, reason: "PLAYER_NOT_REGISTERED" },
      (id) => names[id] ?? id,
    );
    expect(line).toBe(
      "18H45 : Alice Martin (pas réinscrit pour la saison) → réservé au nom de Joshua JACQUES-PHINERA",
    );
  });

  it("distingue le motif quota", () => {
    const line = formatSubstitution(
      { sessionId: "s1", slotTime: "19H30", replacedUserId: A, jokerBookerId: JOKER, reason: "PLAYER_BOOKING_LIMIT_REACHED" },
      (id) => id,
    );
    expect(line).toContain("quota de réservations atteint");
  });
});
