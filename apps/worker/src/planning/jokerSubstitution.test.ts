import { describe, expect, it } from "vitest";
import {
  applyJokerToPair,
  blamedPlayerIds,
  formatSubstitution,
  isSubstitutableReason,
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
  it("partenaire refusé : le joker le remplace, le titulaire ne bouge pas", () => {
    expect(
      substitutionCandidates({ userId: A, partnerId: B, jokerBookerId: JOKER, blamedIds: [B] }),
    ).toEqual([{ replaced: B, userId: A, partnerId: JOKER }]);
  });

  it("titulaire refusé : le partenaire est promu titulaire, le joker passe partenaire", () => {
    // Le joker n'est sans limite qu'en partenaire : en faire un titulaire sortirait de son
    // cas d'usage, et la place de titulaire exige de toute façon un joueur bien inscrit.
    expect(
      substitutionCandidates({ userId: A, partnerId: B, jokerBookerId: JOKER, blamedIds: [A] }),
    ).toEqual([{ replaced: A, userId: B, partnerId: JOKER }]);
  });

  it("les deux joueurs refusés : rien à tenter, aucun titulaire valide", () => {
    expect(
      substitutionCandidates({ userId: A, partnerId: B, jokerBookerId: JOKER, blamedIds: [A, B] }),
    ).toEqual([]);
  });

  it("sans joueur désigné (quota TeamR) : tente le partenaire puis la promotion", () => {
    expect(
      substitutionCandidates({ userId: A, partnerId: B, jokerBookerId: JOKER, blamedIds: [] }),
    ).toEqual([
      { replaced: B, userId: A, partnerId: JOKER },
      { replaced: A, userId: B, partnerId: JOKER },
    ]);
  });

  it("le joker n'est jamais titulaire, quelle que soit la forme tentée", () => {
    for (const blamedIds of [[], [A], [B]]) {
      for (const c of substitutionCandidates({ userId: A, partnerId: B, jokerBookerId: JOKER, blamedIds })) {
        expect(c.partnerId).toBe(JOKER);
        expect(c.userId).not.toBe(JOKER);
      }
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

describe("applyJokerToPair (substitution au moment du plan)", () => {
  const unregistered = (...ids: string[]) => new Set(ids);

  it("ne touche pas une paire dont les deux joueurs sont réinscrits", () => {
    expect(
      applyJokerToPair({ userId: A, partnerId: B, jokerBookerId: JOKER, unregisteredPlayerIds: unregistered() }),
    ).toBeNull();
  });

  it("partenaire non réinscrit : le joker prend sa place", () => {
    expect(
      applyJokerToPair({ userId: A, partnerId: B, jokerBookerId: JOKER, unregisteredPlayerIds: unregistered(B) }),
    ).toEqual({ replaced: B, userId: A, partnerId: JOKER });
  });

  it("titulaire non réinscrit : le partenaire est promu, le joker passe partenaire", () => {
    expect(
      applyJokerToPair({ userId: A, partnerId: B, jokerBookerId: JOKER, unregisteredPlayerIds: unregistered(A) }),
    ).toEqual({ replaced: A, userId: B, partnerId: JOKER });
  });

  it("les deux non réinscrits : aucun titulaire valide, rien à faire", () => {
    expect(
      applyJokerToPair({ userId: A, partnerId: B, jokerBookerId: JOKER, unregisteredPlayerIds: unregistered(A, B) }),
    ).toBeNull();
  });

  it("sans joker configuré : rien à faire", () => {
    expect(
      applyJokerToPair({ userId: A, partnerId: B, jokerBookerId: null, unregisteredPlayerIds: unregistered(B) }),
    ).toBeNull();
  });
});
