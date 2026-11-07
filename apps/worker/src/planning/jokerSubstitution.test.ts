import { describe, expect, it } from "vitest";
import {
  blamedPlayerIds,
  bookingSubstitutionCandidates,
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

describe("bookingSubstitutionCandidates — même cascade qu'au plan : prête-noms d'abord, joker en dernier (2026-09-09)", () => {
  const S1 = "sub-1";
  const S2 = "sub-2";

  it("partenaire refusé : chaque prête-nom en partenaire, puis le joker", () => {
    expect(
      bookingSubstitutionCandidates({ userId: A, partnerId: B, jokerBookerId: JOKER, blamedIds: [B], substituteIds: [S1, S2] }),
    ).toEqual([
      { replaced: B, by: S1, kind: "substitute", userId: A, partnerId: S1 },
      { replaced: B, by: S2, kind: "substitute", userId: A, partnerId: S2 },
      { replaced: B, by: JOKER, kind: "joker", userId: A, partnerId: JOKER },
    ]);
  });

  it("titulaire refusé : un prête-nom peut être titulaire, le joker seulement partenaire (partenaire promu)", () => {
    expect(
      bookingSubstitutionCandidates({ userId: A, partnerId: B, jokerBookerId: JOKER, blamedIds: [A], substituteIds: [S1] }),
    ).toEqual([
      { replaced: A, by: S1, kind: "substitute", userId: S1, partnerId: B },
      { replaced: A, by: JOKER, kind: "joker", userId: B, partnerId: JOKER },
    ]);
  });

  it("fautif inconnu (quota TeamR) : partenaire puis titulaire, prête-noms avant joker", () => {
    expect(
      bookingSubstitutionCandidates({ userId: A, partnerId: B, jokerBookerId: JOKER, blamedIds: [], substituteIds: [S1] }),
    ).toEqual([
      { replaced: B, by: S1, kind: "substitute", userId: A, partnerId: S1 },
      { replaced: A, by: S1, kind: "substitute", userId: S1, partnerId: B },
      { replaced: B, by: JOKER, kind: "joker", userId: A, partnerId: JOKER },
      { replaced: A, by: JOKER, kind: "joker", userId: B, partnerId: JOKER },
    ]);
  });

  it("le joker déjà sur la ligne et refusé : les prête-noms le remplacent, lui n'est plus proposé (cas réel job fcd8c206)", () => {
    expect(
      bookingSubstitutionCandidates({ userId: A, partnerId: JOKER, jokerBookerId: JOKER, blamedIds: [], substituteIds: [S1] }),
    ).toEqual([
      { replaced: JOKER, by: S1, kind: "substitute", userId: A, partnerId: S1 },
      { replaced: A, by: S1, kind: "substitute", userId: S1, partnerId: JOKER },
    ]);
  });

  it("les deux joueurs refusés : deux prête-noms couvrent la paire, puis un prête-nom titulaire + joker partenaire", () => {
    expect(
      bookingSubstitutionCandidates({ userId: A, partnerId: B, jokerBookerId: JOKER, blamedIds: [A, B], substituteIds: [S1, S2] }),
    ).toEqual([
      { replaced: A, by: S1, kind: "substitute", userId: S1, partnerId: S2 },
      { replaced: A, by: S2, kind: "substitute", userId: S2, partnerId: S1 },
      { replaced: A, by: S1, kind: "substitute", userId: S1, partnerId: JOKER },
      { replaced: A, by: S2, kind: "substitute", userId: S2, partnerId: JOKER },
    ]);
  });

  it("les deux joueurs refusés, un seul prête-nom et pas de joker : rien à tenter", () => {
    expect(
      bookingSubstitutionCandidates({ userId: A, partnerId: B, jokerBookerId: null, blamedIds: [A, B], substituteIds: [S1] }),
    ).toEqual([]);
  });

  it("un prête-nom déjà sur la ligne n'est pas proposé", () => {
    expect(
      bookingSubstitutionCandidates({ userId: A, partnerId: S1, jokerBookerId: null, blamedIds: [A], substituteIds: [S1, S2] }),
    ).toEqual([{ replaced: A, by: S2, kind: "substitute", userId: S2, partnerId: S1 }]);
  });

  it("sans prête-nom : identique à substitutionCandidates", () => {
    expect(
      bookingSubstitutionCandidates({ userId: A, partnerId: B, jokerBookerId: JOKER, blamedIds: [B], substituteIds: [] }),
    ).toEqual([{ replaced: B, by: JOKER, kind: "joker", userId: A, partnerId: JOKER }]);
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
      "18H45 : Alice Martin (pas réinscrit pour la saison) → réservé au nom du joker Joshua JACQUES-PHINERA",
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
