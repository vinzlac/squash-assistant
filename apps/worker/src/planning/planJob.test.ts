import { describe, expect, it } from "vitest";
import { cascadeSoloVotersForward, planJobBookings } from "./planJob.js";
import type { AvailableSlot } from "./courtAssignment.js";
import type { BookingRule } from "../config.js";

function rule(overrides: Partial<BookingRule> = {}): BookingRule {
  return {
    id: "squash-samedi-matin",
    name: null,
    enabled: true,
    whatsappGroupJid: "group@test",
    resaSquashGroupId: "group-1",
    pollCron: "0 10 * * 6",
    decisionCron: "30 21 * * 5",
    targetWeekdayOffset: 1,
    candidateStartTimes: ["10H30"],
    maxCourtsPerSlot: 3,
    minPlayersPerCourt: 2,
    maxPlayersPerCourt: 3,
    maxReservationsPerPlayer: 1,
    priorityBookers: [],
    preferMinPlayersPerCourt: false,
    courtPriority: [4, 3, 2, 1],
    availabilityWindowHours: 3,
    description: null,
    substituteBookers: [],
    maxDailyReservationsPerPlayer: 2,
    unexpectedPlayersMargin: 0,
    reservationNotifyWhatsappGroupJid: null,
    cronJitterWindowMinutes: 60,
    requireTelegramGoForAutoJobs: true,
    nextDayReminderEnabled: false,
    jokerBookerId: null,
    ...overrides,
  };
}

function makeSlots(courts: number[], beginTime: string, endTime: string): AvailableSlot[] {
  return courts.map((court) => ({ sessionId: `s-${court}-${beginTime}`, court, beginTime, endTime }));
}

describe("cascadeSoloVotersForward", () => {
  it("déplace un joueur seul vers l'heure candidate suivante", () => {
    const result = cascadeSoloVotersForward(
      ["18H45", "19H30"],
      { "18H45": ["terence"], "19H30": ["martin"] },
    );
    expect(result).toEqual({ "18H45": [], "19H30": ["martin", "terence"] });
  });

  it("ne déplace rien si le joueur a un partenaire à son heure", () => {
    const result = cascadeSoloVotersForward(
      ["18H45", "19H30"],
      { "18H45": ["terence", "julie"], "19H30": ["martin"] },
    );
    expect(result).toEqual({ "18H45": ["terence", "julie"], "19H30": ["martin"] });
  });

  it("ne cascade pas au-delà de l'heure suivante immédiate", () => {
    const result = cascadeSoloVotersForward(
      ["18H45", "19H30", "20H15"],
      { "18H45": ["terence"], "19H30": [], "20H15": ["martin", "julie"] },
    );
    // terence rejoint 19H30 (qui devient seul à son tour) — pas de 2e saut vers 20H15.
    expect(result).toEqual({ "18H45": [], "19H30": ["terence"], "20H15": ["martin", "julie"] });
  });

  it("ne déplace rien depuis la dernière heure candidate (pas d'heure suivante)", () => {
    const result = cascadeSoloVotersForward(["18H45", "19H30"], { "18H45": [], "19H30": ["martin"] });
    expect(result).toEqual({ "18H45": [], "19H30": ["martin"] });
  });

  it("n'évalue pas une heure comme source de cascade si elle a déjà reçu un partenaire cascadé (3 heures)", () => {
    // A et B sont chacun seuls à l'origine ; C a déjà 2 joueurs.
    // a cascade de A vers B en premier — B a alors 2 joueurs (b + a) et ne doit plus
    // être considéré comme "seul" pour un 2e saut vers C, même si son snapshot
    // d'origine (avant cascade) était de longueur 1.
    const result = cascadeSoloVotersForward(
      ["A", "B", "C"],
      { A: ["a"], B: ["b"], C: ["c", "d"] },
    );
    expect(result).toEqual({ A: [], B: ["b", "a"], C: ["c", "d"] });
  });
});

describe("planJobBookings — cascade joueur seul", () => {
  it("un joueur seul à la 1ère heure est réservé à la 2e heure avec le joueur qui y était", () => {
    const availableSlots = makeSlots([1, 2], "19H30", "20H15");
    const groups = planJobBookings(
      rule({ candidateStartTimes: ["18H45", "19H30"] }),
      "2026-08-08",
      { "18H45": ["terence"], "19H30": ["martin"] },
      [],
      availableSlots,
      null,
    );
    expect(groups[0]!.plan.proposedBookings).toEqual([]);
    expect(groups[1]!.plan.proposedBookings).toEqual([
      expect.objectContaining({ userId: "martin", partnerId: "terence" }),
    ]);
  });
});

describe("planJobBookings — marge joueurs imprévus", () => {
  it("marge à 0 (défaut) : comportement inchangé, pas de joueur ajouté", () => {
    const availableSlots = makeSlots([1, 2], "10H30", "11H15");
    const groups = planJobBookings(
      rule({ unexpectedPlayersMargin: 0 }),
      "2026-08-08",
      { "10H30": ["a", "b"] },
      [],
      availableSlots,
      null,
    );
    expect(groups[0]!.plan.proposedBookings).toEqual([
      expect.objectContaining({ userId: "a", partnerId: "b" }),
    ]);
  });

  it("marge à 1 : un joueur supplémentaire (issu de substituteBookers) est traité comme un vrai confirmé sur l'heure ayant des confirmés", () => {
    const availableSlots = makeSlots([1, 2], "10H30", "11H15");
    const groups = planJobBookings(
      rule({ unexpectedPlayersMargin: 1, substituteBookers: ["sebastien"] }),
      "2026-08-08",
      { "10H30": ["a", "b", "c"] },
      [],
      availableSlots,
      null,
    );
    // a+b, c+sebastien (sebastien traité comme confirmé, pas comme prête-nom de repli).
    expect(groups[0]!.plan.proposedBookings).toHaveLength(2);
    const allIds = groups[0]!.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId]);
    expect(allIds).toContain("sebastien");
    expect(groups[0]!.plan.warnings.some((w) => w.includes("Effectif impair"))).toBe(false);
  });

  it("la marge pioche aussi dans les volontaires du sondage \"Prête mon nom\" (ADR-017), prioritaires sur substituteBookers", () => {
    const availableSlots = makeSlots([1, 2], "10H30", "11H15");
    const groups = planJobBookings(
      rule({ unexpectedPlayersMargin: 1, substituteBookers: ["sebastien"] }),
      "2026-08-08",
      { "10H30": ["a", "b", "c"] },
      ["mustapha"], // volontaire du sondage — même sans substituteBookers configuré (règle vide en pratique).
      availableSlots,
      null,
    );
    const allIds = groups[0]!.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId]);
    expect(allIds).toContain("mustapha");
    expect(allIds).not.toContain("sebastien"); // le volontaire suffit pour la marge de 1, le défaut n'est pas consommé.
  });

  it("marge sans heure ayant de confirmés : aucun joueur de marge ajouté (rien à provisionner en plus de zéro)", () => {
    const availableSlots = makeSlots([1, 2], "10H30", "11H15");
    const groups = planJobBookings(
      rule({ unexpectedPlayersMargin: 2, substituteBookers: ["sebastien", "mustapha"] }),
      "2026-08-08",
      { "10H30": [] },
      [],
      availableSlots,
      null,
    );
    expect(groups[0]!.plan.proposedBookings).toEqual([]);
    expect(groups[0]!.plan.warnings.some((w) => w.includes("Pas assez de joueurs confirmés"))).toBe(true);
  });

  it("un joueur de marge consommé à une heure n'est jamais réutilisé à une autre heure le même jour", () => {
    const availableSlots = [...makeSlots([1, 2], "10H30", "11H15"), ...makeSlots([1, 2], "11H15", "12H00")];
    const groups = planJobBookings(
      rule({
        candidateStartTimes: ["10H30", "11H15"],
        unexpectedPlayersMargin: 1,
        substituteBookers: ["sebastien"],
      }),
      "2026-08-08",
      { "10H30": ["a", "b", "c"], "11H15": ["d", "e"] },
      [],
      availableSlots,
      null,
    );
    // Un seul prête-nom disponible : consommé par la 1ère heure ayant des confirmés (effectif impair
    // 3 → pair avec la marge), pas dispo pour la 2e (déjà pair, la marge n'y est donc pas nécessaire
    // mais le pool reste vide de toute façon).
    const ids1030 = groups[0]!.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId]);
    const ids1115 = groups[1]!.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId]);
    expect(ids1030).toContain("sebastien");
    expect(ids1115).not.toContain("sebastien");
  });
});

describe("planJobBookings — fusion cross-heures + rotation", () => {
  const vincent = "60bf2fdd1fd8d20020d2c8a7";
  const terence = "60bf46402d842c0027a508d4";
  const martin = "60e23b69a78d1100206b808c";

  function slotsForScenario(): AvailableSlot[] {
    const times = ["18H45", "19H30", "20H15", "21H00", "21H45"];
    const slots: AvailableSlot[] = [];
    let seq = 0;
    for (const beginTime of times) {
      const endParts = beginTime.match(/^(\d+)H(\d+)$/);
      if (!endParts) continue;
      const beginMin = Number(endParts[1]) * 60 + Number(endParts[2]);
      const endTime = `${String(Math.floor((beginMin + 45) / 60)).padStart(2, "0")}H${String((beginMin + 45) % 60).padStart(2, "0")}`.replace(
        /^0?(\d+)H/,
        (_, h) => `${h}H`,
      );
      for (let court = 1; court <= 4; court += 1) {
        seq += 1;
        slots.push({ sessionId: `s-${seq}`, court, beginTime, endTime: endTime === "19H60" ? "20H15" : endTime });
      }
    }
    return slots;
  }

  it("2 @ 18H45 + 1 @ 19H30 + prête-nom : V/T plafonnés à 2, puis Martin+prête-nom", () => {
    const mustapha = "60be7781b884160020172c3a";
    const groups = planJobBookings(
      rule({
        id: "squashacademie-mardi",
        resaSquashGroupId: "group-1",
        candidateStartTimes: ["18H45", "19H30"],
        maxReservationsPerPlayer: 2,
        maxDailyReservationsPerPlayer: 2,
        courtPriority: [4, 3, 2, 1],
      }),
      "2026-08-11",
      { "18H45": [vincent, terence], "19H30": [martin] },
      [mustapha],
      slotsForScenario(),
      null,
    );

    const bookings = groups[0]!.plan.proposedBookings;
    expect(bookings).toHaveLength(4);
    expect(bookings.every((b) => b.court === 4)).toBe(true);
    expect(bookings.slice(0, 2).every((b) => b.userId === vincent && b.partnerId === terence)).toBe(true);
    expect(bookings[0]!.slotTime).toBe("18H45");
    expect(bookings[1]!.slotTime).toBe("19H30");
    expect(bookings[2]!).toMatchObject({ slotTime: "20H15", userId: martin, partnerId: mustapha });
    expect(bookings[3]!).toMatchObject({ slotTime: "21H00", userId: martin, partnerId: mustapha });
    // Plafond TeamR : Vincent et Terence exactement 2 fois, jamais 4.
    expect(bookings.filter((b) => b.userId === vincent || b.partnerId === vincent)).toHaveLength(2);
    expect(bookings.filter((b) => b.userId === terence || b.partnerId === terence)).toHaveLength(2);
    expect(groups[1]!.plan.warnings.some((w) => w.includes("fusionné"))).toBe(true);
  });

  it("sans prête-nom : shortfall min effectif pour le late joiner", () => {
    const groups = planJobBookings(
      rule({
        id: "squashacademie-mardi",
        resaSquashGroupId: "group-1",
        candidateStartTimes: ["18H45", "19H30"],
        maxReservationsPerPlayer: 2,
        maxDailyReservationsPerPlayer: 2,
        courtPriority: [4, 3, 2, 1],
        substituteBookers: [],
      }),
      "2026-08-11",
      { "18H45": [vincent, terence], "19H30": [martin] },
      [],
      slotsForScenario(),
      null,
    );

    const bookings = groups[0]!.plan.proposedBookings;
    expect(bookings).toHaveLength(2);
    expect(groups[0]!.plan.warnings.some((w) => w.includes("min effectif"))).toBe(true);
  });

  it("min effectif surchargé à 1 pour le late joiner : une seule prolongation TeamR", () => {
    const mustapha = "60be7781b884160020172c3a";
    const groups = planJobBookings(
      rule({
        id: "squashacademie-mardi",
        resaSquashGroupId: "group-1",
        candidateStartTimes: ["18H45", "19H30"],
        maxReservationsPerPlayer: 2,
        maxDailyReservationsPerPlayer: 2,
        courtPriority: [4, 3, 2, 1],
      }),
      "2026-08-11",
      { "18H45": [vincent, terence], "19H30": [martin] },
      [mustapha],
      slotsForScenario(),
      null,
      {
        defaults: { defaultMinPlaySlots: 2, defaultMaxPlaySlots: 2 },
        overrides: new Map([[martin, { minSlots: 1, maxSlots: 1 }]]),
      },
    );

    // V/T ont besoin d'1 créneau de plus après l'arrivée de Martin (75→105 min) ;
    // Martin atteint son min=1 sur ce même créneau (30+30≥45) — pas de 2e Martin+Mustapha.
    const bookings = groups[0]!.plan.proposedBookings;
    expect(bookings).toHaveLength(3);
    expect(bookings[2]!).toMatchObject({ slotTime: "20H15", userId: martin, partnerId: mustapha });
  });
});

describe("planJobBookings — joueurs non réinscrits remplacés par le joker (ADR-024)", () => {
  const JOKER = "joshua";
  const availableSlots = () => makeSlots([1, 2], "10H30", "11H15");

  it("partenaire non réinscrit : la ligne est proposée au nom du joker dès le plan", () => {
    const groups = planJobBookings(
      rule({ jokerBookerId: JOKER }),
      "2026-08-08",
      { "10H30": ["a", "b"] },
      [],
      availableSlots(),
      null,
      undefined,
      new Set(["b"]),
    );

    expect(groups[0]!.plan.proposedBookings).toEqual([
      expect.objectContaining({ userId: "a", partnerId: JOKER }),
    ]);
    expect(groups[0]!.plan.warnings.some((w) => w.includes("pas réinscrit"))).toBe(true);
  });

  it("titulaire non réinscrit : le partenaire est promu, le joker passe partenaire", () => {
    const groups = planJobBookings(
      rule({ jokerBookerId: JOKER }),
      "2026-08-08",
      { "10H30": ["a", "b"] },
      [],
      availableSlots(),
      null,
      undefined,
      new Set(["a"]),
    );

    expect(groups[0]!.plan.proposedBookings).toEqual([
      expect.objectContaining({ userId: "b", partnerId: JOKER }),
    ]);
  });

  it("sans joker configuré : la paire est écartée plutôt que proposée pour échouer à l'étape 4", () => {
    const groups = planJobBookings(
      rule({ jokerBookerId: null }),
      "2026-08-08",
      { "10H30": ["a", "b"] },
      [],
      availableSlots(),
      null,
      undefined,
      new Set(["b"]),
    );

    expect(groups[0]!.plan.proposedBookings).toEqual([]);
    expect(groups[0]!.plan.warnings.some((w) => w.includes("aucun joker configuré"))).toBe(true);
  });

  it("aucun joueur non réinscrit : plan strictement inchangé", () => {
    const withJoker = planJobBookings(
      rule({ jokerBookerId: JOKER }),
      "2026-08-08",
      { "10H30": ["a", "b"] },
      [],
      availableSlots(),
      null,
      undefined,
      new Set(),
    );

    expect(withJoker[0]!.plan.proposedBookings).toEqual([
      expect.objectContaining({ userId: "a", partnerId: "b" }),
    ]);
    expect(withJoker[0]!.plan.warnings.some((w) => w.includes("réinscrit"))).toBe(false);
  });

  it("le joker n'est pas soumis au plafond de résas/jour : il porte plusieurs lignes", () => {
    // 4 joueurs, tous non réinscrits sauf les titulaires : 2 paires sur la même heure, le joker
    // est partenaire des deux — un plafond appliqué au joker les aurait fait sauter.
    const groups = planJobBookings(
      rule({ jokerBookerId: JOKER, maxDailyReservationsPerPlayer: 1, maxReservationsPerPlayer: 1 }),
      "2026-08-08",
      { "10H30": ["a", "b", "c", "d"] },
      [],
      availableSlots(),
      null,
      undefined,
      new Set(["b", "d"]),
    );

    const bookings = groups[0]!.plan.proposedBookings;
    expect(bookings).toHaveLength(2);
    expect(bookings.every((b) => b.partnerId === JOKER)).toBe(true);
    expect(bookings.map((b) => b.userId).sort()).toEqual(["a", "c"]);
  });
});

describe("planJobBookings — joker en repli du plafond maison (règle 2026-09-01)", () => {
  const JOKER = "joshua";
  const slots = () => [
    ...makeSlots([1], "18H45", "19H30"),
    ...makeSlots([1], "19H30", "20H15"),
    ...makeSlots([1], "20H15", "21H00"),
  ];
  /** 3 joueurs en rotation, plafond 1 résa/jour : le 2e round bute sur le plafond du titulaire. */
  const baseRule = (overrides: Partial<BookingRule> = {}) =>
    rule({
      jokerBookerId: JOKER,
      substituteBookers: [],
      maxDailyReservationsPerPlayer: 1,
      candidateStartTimes: ["18H45"],
      ...overrides,
    });

  it("plafond atteint sans prête-nom : le joker prend la place plutôt que d'abandonner la paire", () => {
    // Cas réel du 2026-09-01 : « plafond N résas ce jour atteint — réservation ignorée pour
    // cette paire, aucun prête-nom disponible » sur un court pourtant libre.
    const groups = planJobBookings(baseRule(), "2026-08-08", { "18H45": ["a", "b", "c"] }, [], slots(), null);

    const bookings = groups[0]!.plan.proposedBookings;
    expect(bookings.length).toBeGreaterThanOrEqual(2);
    // Le joker n'occupe jamais la place de titulaire.
    expect(bookings.some((b) => b.partnerId === JOKER)).toBe(true);
    expect(bookings.some((b) => b.userId === JOKER)).toBe(false);
    expect(groups[0]!.plan.warnings.some((w) => w.includes("joker") && w.includes("plafond"))).toBe(true);
  });

  it("un prête-nom disponible reste prioritaire sur le joker", () => {
    const groups = planJobBookings(
      baseRule({ substituteBookers: ["sebastien"] }),
      "2026-08-08",
      { "18H45": ["a", "b", "c"] },
      [],
      slots(),
      null,
    );

    const bookings = groups[0]!.plan.proposedBookings;
    const names = bookings.flatMap((b) => [b.userId, b.partnerId]);
    expect(names).toContain("sebastien");
    // Le prête-nom est consommé avant que le joker n'entre en jeu.
    expect(names.indexOf("sebastien")).toBeLessThan(
      names.includes(JOKER) ? names.indexOf(JOKER) : Number.MAX_SAFE_INTEGER,
    );
  });
});
