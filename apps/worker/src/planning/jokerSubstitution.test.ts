import { describe, expect, it } from "vitest";
import {
  blamedPlayerIds,
  formatSubstitution,
  isSubstitutableReason,
  resolveBookablePair,
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

describe("resolveBookablePair — prête-noms d'abord, joker en dernier recours", () => {
  const C = "player-c";
  const SUB1 = "sub-1";
  const SUB2 = "sub-2";

  it("paire valide : rien n'est consommé ni remplacé", () => {
    const queue = [SUB1];
    expect(
      resolveBookablePair({ userId: A, partnerId: B, blockedIds: new Set(), substituteQueue: queue, jokerBookerId: JOKER }),
    ).toEqual({ userId: A, partnerId: B, replacements: [] });
    expect(queue).toEqual([SUB1]);
  });

  it("un prête-nom disponible est préféré au joker", () => {
    const queue = [SUB1];
    const resolved = resolveBookablePair({
      userId: A,
      partnerId: B,
      blockedIds: new Set([B]),
      substituteQueue: queue,
      jokerBookerId: JOKER,
    });
    expect(resolved).toEqual({
      userId: A,
      partnerId: SUB1,
      replacements: [{ replaced: B, by: SUB1, kind: "substitute" }],
    });
    expect(queue).toEqual([]);
  });

  it("file de prête-noms vide : le joker prend la place de partenaire", () => {
    const queue: string[] = [];
    expect(
      resolveBookablePair({ userId: A, partnerId: B, blockedIds: new Set([B]), substituteQueue: queue, jokerBookerId: JOKER }),
    ).toEqual({
      userId: A,
      partnerId: JOKER,
      replacements: [{ replaced: B, by: JOKER, kind: "joker" }],
    });
  });

  it("titulaire bloqué et plus de prête-nom : le partenaire est promu, le joker passe partenaire", () => {
    expect(
      resolveBookablePair({ userId: A, partnerId: B, blockedIds: new Set([A]), substituteQueue: [], jokerBookerId: JOKER }),
    ).toEqual({
      userId: B,
      partnerId: JOKER,
      replacements: [{ replaced: A, by: JOKER, kind: "joker" }],
    });
  });

  it("les deux bloqués : un prête-nom couvre l'un, le joker couvre l'autre", () => {
    const queue = [SUB1];
    const resolved = resolveBookablePair({
      userId: A,
      partnerId: B,
      blockedIds: new Set([A, B]),
      substituteQueue: queue,
      jokerBookerId: JOKER,
    });
    expect(resolved).toEqual({
      userId: SUB1,
      partnerId: JOKER,
      replacements: [
        { replaced: A, by: SUB1, kind: "substitute" },
        { replaced: B, by: JOKER, kind: "joker" },
      ],
    });
    expect(queue).toEqual([]);
  });

  it("les deux bloqués sans aucun prête-nom : le joker ne couvre qu'une place, paire abandonnée", () => {
    expect(
      resolveBookablePair({ userId: A, partnerId: B, blockedIds: new Set([A, B]), substituteQueue: [], jokerBookerId: JOKER }),
    ).toBeNull();
  });

  it("un prête-nom lui-même bloqué (non réinscrit) est ignoré au profit du suivant", () => {
    const queue = [SUB1, SUB2];
    const resolved = resolveBookablePair({
      userId: A,
      partnerId: B,
      blockedIds: new Set([B, SUB1]),
      substituteQueue: queue,
      jokerBookerId: JOKER,
    });
    expect(resolved).toMatchObject({ userId: A, partnerId: SUB2 });
    expect(queue).toEqual([SUB1]);
  });

  it("tous les prête-noms bloqués : repli sur le joker, file intacte", () => {
    const queue = [SUB1];
    const resolved = resolveBookablePair({
      userId: A,
      partnerId: B,
      blockedIds: new Set([B, SUB1]),
      substituteQueue: queue,
      jokerBookerId: JOKER,
    });
    expect(resolved).toMatchObject({ userId: A, partnerId: JOKER });
    expect(queue).toEqual([SUB1]);
  });

  it("sans joker configuré et sans prête-nom : paire abandonnée (comportement historique)", () => {
    expect(
      resolveBookablePair({ userId: A, partnerId: B, blockedIds: new Set([B]), substituteQueue: [], jokerBookerId: null }),
    ).toBeNull();
  });

  it("le joker n'est jamais considéré comme bloqué, même listé dans blockedIds", () => {
    // Un plafond de résas/jour ne s'applique pas au gérant du club.
    expect(
      resolveBookablePair({
        userId: A,
        partnerId: JOKER,
        blockedIds: new Set([JOKER]),
        substituteQueue: [],
        jokerBookerId: JOKER,
      }),
    ).toEqual({ userId: A, partnerId: JOKER, replacements: [] });
  });

  it("ne propose jamais deux fois le même nom sur une ligne", () => {
    const resolved = resolveBookablePair({
      userId: A,
      partnerId: B,
      blockedIds: new Set([A]),
      substituteQueue: [B],
      jokerBookerId: JOKER,
    });
    expect(resolved?.userId).not.toBe(resolved?.partnerId);
  });
});
