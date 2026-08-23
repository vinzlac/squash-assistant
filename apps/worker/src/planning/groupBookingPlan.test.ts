import { describe, expect, it } from "vitest";
import { computeGroupBookingPlan, type ComputeGroupBookingPlanInput } from "./groupBookingPlan.js";
import type { AvailableSlot } from "./courtAssignment.js";

function baseInput(overrides: Partial<ComputeGroupBookingPlanInput> = {}): ComputeGroupBookingPlanInput {
  return {
    groupId: "group-1",
    onDate: "2026-08-04",
    expectedPlayerIds: [],
    substitutePlayerIds: [],
    slotsPerPlayer: 2,
    maxCourts: 3,
    preferMinPlayersPerCourt: false,
    courtPriority: [4, 3, 2, 1],
    startTime: "18H45",
    availableSlots: [],
    usedSessionIds: new Set(),
    apiUserId: null,
    existingDailyCounts: {},
    maxDailyReservationsPerPlayer: 2,
    maxPlayersPerCourt: 3,
    availabilityWindowHours: 3,
    ...overrides,
  };
}

function makeSlots(courts: number[], beginTime: string, endTime: string): AvailableSlot[] {
  return courts.map((court) => ({ sessionId: `s-${court}-${beginTime}`, court, beginTime, endTime }));
}

describe("computeGroupBookingPlan", () => {
  it("2 joueurs, 2 courts libres sur 2 créneaux successifs : 2 réservations, même court", () => {
    const availableSlots = [
      ...makeSlots([4, 3], "18H45", "19H30"),
      ...makeSlots([4, 3], "19H30", "20H15"),
    ];
    const plan = computeGroupBookingPlan(
      baseInput({ expectedPlayerIds: ["a", "b"], availableSlots }),
    );
    expect(plan.proposedBookings).toHaveLength(2);
    expect(plan.proposedBookings.every((b) => b.court === plan.proposedBookings[0]!.court)).toBe(true);
    expect(plan.proposedBookings.map((b) => b.slotTime)).toEqual(["18H45", "19H30"]);
    expect(plan.meta.pairCount).toBe(1);
    expect(plan.warnings).toEqual([]);
  });

  it("scénario régression exact du bug rapporté 2026-07-28 : 3 confirmés + 2 prête-noms + titulaire à quota, puis 2 confirmés à l'heure suivante — aucun conflit de court possible", () => {
    const availableSlots = [
      ...makeSlots([1, 2, 3, 4], "18H45", "19H30"),
      ...makeSlots([1, 2, 3, 4], "19H30", "20H15"),
      ...makeSlots([1, 2, 3, 4], "20H15", "21H00"),
    ];

    // 18H45 : Vincent, Stéphane, Terence (effectif impair) + 2 prête-noms (Sébastien, Mustapha).
    const plan1845 = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["vincent", "stephane", "terence"],
        substitutePlayerIds: ["sebastien", "mustapha"],
        startTime: "18H45",
        availableSlots,
      }),
    );

    const usedSessionIds = new Set(plan1845.proposedBookings.map((b) => b.sessionId));

    // 19H30 : Martin + Tin, en tenant compte des créneaux déjà retenus par le groupe 18H45.
    const plan1930 = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["martin", "tin"],
        startTime: "19H30",
        availableSlots,
        usedSessionIds,
      }),
    );

    // Aucun sessionId du groupe 19H30 ne doit chevaucher un sessionId déjà retenu par le groupe 18H45.
    const overlap = plan1930.proposedBookings.filter((b) => usedSessionIds.has(b.sessionId));
    expect(overlap).toEqual([]);
  });

  it("effectif impair, cas courant (1 court) : le joueur en rotation est intégré directement au groupe de 3, warning explicite", () => {
    // Avec courtsNeeded=1 et 1 seule paire (+1 rotation), on est dans le cas courant
    // (groups.ts fusionne directement le joueur en rotation dans le groupe — plus besoin de
    // prête-nom pour le faire apparaître, contrairement à l'ancien mécanisme de couches).
    const availableSlots = [...makeSlots([4], "18H45", "19H30"), ...makeSlots([4], "19H30", "20H15")];
    const plan = computeGroupBookingPlan(
      baseInput({ expectedPlayerIds: ["a", "b", "c"], availableSlots, maxCourts: 1 }),
    );
    expect(plan.meta.rotatingPlayerIds).toEqual(["c"]);
    expect(plan.proposedBookings.some((b) => b.userId === "c" || b.partnerId === "c")).toBe(true);
    expect(plan.warnings.some((w) => w.includes("rotation"))).toBe(true);
  });

  it("aucun créneau disponible : plan vide avec warning, pas d'exception", () => {
    const plan = computeGroupBookingPlan(baseInput({ expectedPlayerIds: ["a", "b"], availableSlots: [] }));
    expect(plan.proposedBookings).toEqual([]);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it("joueur non-titulaire à quota avec prête-nom disponible : remplacé, titulaire jamais concerné", () => {
    const availableSlots = makeSlots([4], "18H45", "19H30");
    const plan = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["vincent", "stephane"],
        substitutePlayerIds: ["sebastien"],
        slotsPerPlayer: 1,
        availableSlots,
        apiUserId: "vincent", // exempté : jamais plafonné ni substitué, quel que soit son nombre de résas.
        existingDailyCounts: { stephane: 2 }, // stephane a déjà atteint le plafond sur une heure candidate précédente.
        maxDailyReservationsPerPlayer: 2,
      }),
    );
    expect(plan.proposedBookings).toEqual([
      expect.objectContaining({ userId: "vincent", partnerId: "sebastien" }),
    ]);
    expect(plan.warnings.some((w) => w.includes("stephane : plafond") && w.includes("remplacé par le prête-nom sebastien"))).toBe(
      true,
    );
  });

  it("le titulaire de la clé API n'a jamais de plafond, même en jouant plus que maxDailyReservationsPerPlayer", () => {
    const availableSlots = [
      ...makeSlots([4, 3], "18H45", "19H30"),
      ...makeSlots([4, 3], "19H30", "20H15"),
      ...makeSlots([4, 3], "20H15", "21H00"),
    ];
    const plan = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["vincent", "stephane"],
        substitutePlayerIds: ["sebastien"], // couvre le dépassement de plafond de stephane (lui n'est pas exempté).
        // vincent apparaîtrait 3 fois, au-delà du plafond de 2 s'il n'était pas exempté (cas
        // courant : le nombre de rounds vient de playerPlaySlots, plus de slotsPerPlayer).
        playerPlaySlots: new Map([["vincent", { minSlots: 3, maxSlots: 3 }]]),
        availableSlots,
        apiUserId: "vincent",
        maxDailyReservationsPerPlayer: 2,
      }),
    );
    expect(plan.proposedBookings).toHaveLength(3);
    expect(plan.proposedBookings.every((b) => b.userId === "vincent")).toBe(true);
    expect(plan.warnings.some((w) => w.includes("vincent"))).toBe(false);
  });

  it("continuité de court maintenue même quand la paire substituée change de prête-nom d'un round à l'autre", () => {
    // Vincent+Martin sur 2 rounds successifs, Vincent (non-titulaire ici) déjà à quota dès le round 1 :
    // chaque round le remplace par un prête-nom différent (tin puis paul, queue consommée une fois par round).
    // Round 1 n'a qu'un seul court dispo (3) ; round 2 en a deux (3 et 4, 4 mieux classé en
    // courtPriority) : sans lien "vraie identité de paire" entre tin+martin et paul+martin,
    // la continuité ne peut pas être détectée et le plan basculerait sur le court 4 au round 2.
    const availableSlots = [
      ...makeSlots([3], "18H45", "19H30"),
      ...makeSlots([3, 4], "19H30", "20H15"),
    ];
    const plan = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["vincent", "martin"],
        substitutePlayerIds: ["tin", "paul"],
        slotsPerPlayer: 2,
        courtPriority: [4, 3, 2, 1],
        availableSlots,
        existingDailyCounts: { vincent: 2 }, // déjà à quota avant même ce plan (heure candidate précédente).
        maxDailyReservationsPerPlayer: 2,
      }),
    );
    expect(plan.proposedBookings).toEqual([
      expect.objectContaining({ userId: "tin", partnerId: "martin", court: 3, slotTime: "18H45" }),
      expect.objectContaining({ userId: "paul", partnerId: "martin", court: 3, slotTime: "19H30" }),
    ]);
  });

  it("joueur non-titulaire à quota sans prête-nom disponible : réservation ignorée pour cette paire, warning explicite", () => {
    const availableSlots = makeSlots([4], "18H45", "19H30");
    const plan = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["vincent", "stephane"],
        substitutePlayerIds: [],
        slotsPerPlayer: 1,
        availableSlots,
        apiUserId: "vincent",
        existingDailyCounts: { stephane: 2 },
        maxDailyReservationsPerPlayer: 2,
      }),
    );
    expect(plan.proposedBookings).toEqual([]);
    expect(plan.warnings.some((w) => w.includes("stephane : plafond") && w.includes("aucun prête-nom disponible"))).toBe(
      true,
    );
  });

  it("scénario régression 2026-08-02 : 8 joueurs, plafond 3 courts, 2 couches — jamais plus de 3 courts simultanés (le round « débordé » d'une couche ne doit pas se cumuler avec le round normal d'une autre couche au même horaire)", () => {
    const availableSlots = [...makeSlots([1, 2, 3, 4], "10H30", "11H15"), ...makeSlots([1, 2, 3, 4], "11H15", "12H00")];
    const plan = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["a", "b", "c", "d", "e", "f", "g", "h"],
        slotsPerPlayer: 2,
        maxCourts: 3,
        preferMinPlayersPerCourt: true,
        startTime: "10H30",
        availableSlots,
      }),
    );
    const courtsByTime = new Map<string, Set<number>>();
    for (const b of plan.proposedBookings) {
      const set = courtsByTime.get(b.slotTime) ?? new Set<number>();
      set.add(b.court);
      courtsByTime.set(b.slotTime, set);
    }
    for (const [, courts] of courtsByTime) {
      expect(courts.size).toBeLessThanOrEqual(3);
    }
    expect(plan.warnings.some((w) => w.includes("Il faudrait 4 court(s) ; plafond 3"))).toBe(true);
  });

  it("régression 2026-08-23 : 7 joueurs sur 3 courts (plafond 2 résas/jour atteint par les 6 premiers) — le 7e joueur doit être intégré par rotation via un prête-nom, pas disparaître silencieusement", () => {
    // 7 confirmés → 3 paires (6 joueurs) + 1 rotatingPlayerId ("g"). buildOngoingSessionsFromPlan
    // ne doit pas traiter les 6 autres joueurs comme déjà présents sur les 3 courts à la fois
    // (bug : "g" disparaissait du plan sans laisser de trace, alors qu'un prête-nom était
    // disponible pour tenir la ligne TeamR pendant que "g" tourne physiquement sur le court).
    const availableSlots = [
      ...makeSlots([1, 2, 3], "10H30", "11H15"),
      ...makeSlots([1, 2, 3], "11H15", "12H00"),
      ...makeSlots([1, 2, 3], "12H00", "12H45"),
    ];
    const plan = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["a", "b", "c", "d", "e", "f", "g"],
        substitutePlayerIds: ["h"],
        slotsPerPlayer: 2,
        maxCourts: 3,
        startTime: "10H30",
        availableSlots,
        availabilityWindowHours: 3,
      }),
    );

    expect(plan.proposedBookings.some((b) => b.userId === "g" || b.partnerId === "g")).toBe(true);
    // "g" ne doit être physiquement que sur un seul court à la fois.
    const courtsForG = new Set(
      plan.proposedBookings.filter((b) => b.userId === "g" || b.partnerId === "g").map((b) => b.court),
    );
    expect(courtsForG.size).toBe(1);
    // Le court où "g" tourne doit avoir 3 créneaux (2h15) au lieu de 2 (1h30) pour les 2 autres
    // courts — c'est ce qui donne à a/b/g un temps de jeu effectif équitable (§ calcul utilisateur).
    const [gCourt] = courtsForG;
    const slotsOnGCourt = plan.proposedBookings.filter((b) => b.court === gCourt).length;
    const slotsOnOtherCourts = plan.proposedBookings.filter((b) => b.court !== gCourt).length;
    expect(slotsOnGCourt).toBe(3);
    expect(slotsOnOtherCourts).toBe(4); // 2 autres courts × 2 créneaux chacun.
  });

  it("régression 2026-08-23 : 7 joueurs, 3 courts, préférences par défaut — le groupe fusionné avec le 7e joueur va jusqu'à 3 rounds (pas 4), les 2 autres s'arrêtent à leur minSlots par défaut (2)", () => {
    const availableSlots = [
      ...makeSlots([1, 2, 3], "10H30", "11H15"),
      ...makeSlots([1, 2, 3], "11H15", "12H00"),
      ...makeSlots([1, 2, 3], "12H00", "12H45"),
    ];
    const plan = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["a", "b", "c", "d", "e", "f", "g"],
        startTime: "10H30",
        availableSlots,
      }),
    );

    // Le 7e joueur (rotation) doit apparaître dans le plan, fusionné dans un groupe de 3
    // (cas courant, groups.ts) — plus de disparition silencieuse (régression 2026-08-23).
    expect(plan.proposedBookings.some((b) => b.userId === "g" || b.partnerId === "g")).toBe(true);
    // "g" ne doit être physiquement que sur un seul court à la fois.
    const gCourt = plan.proposedBookings.find((b) => b.userId === "g" || b.partnerId === "g")!.court;
    expect(plan.proposedBookings.every((b) => (b.userId === "g" || b.partnerId === "g" ? b.court === gCourt : true))).toBe(
      true,
    );
    // Groupe de 3 (a+b+g) : round-robin sur 3 rounds pour que chacun atteigne minSlots=2 par
    // défaut (pas 4, contrairement à l'ancien mécanisme d'extension post-hoc). Les 2 autres
    // groupes (paires classiques) s'arrêtent à leur minSlots par défaut (2 rounds chacun).
    expect(plan.proposedBookings.filter((b) => b.court === gCourt)).toHaveLength(3);
    expect(plan.proposedBookings.filter((b) => b.court !== gCourt)).toHaveLength(4);
    expect(plan.proposedBookings).toHaveLength(7);
    expect(new Set(plan.proposedBookings.map((b) => b.slotTime))).toEqual(new Set(["10H30", "11H15", "12H00"]));
  });

  it("préférence individuelle sur une paire classique (bug annexe corrigé) : le membre à minSlots=3 obtient 3 rounds", () => {
    const availableSlots = [
      ...makeSlots([4], "10H30", "11H15"),
      ...makeSlots([4], "11H15", "12H00"),
      ...makeSlots([4], "12H00", "12H45"),
    ];
    const plan = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["a", "b"],
        startTime: "10H30",
        availableSlots,
        playerPlaySlots: new Map([["a", { minSlots: 3, maxSlots: 3 }]]),
        // "b" est nommé sur les 3 rounds (groupe de 2) : plafond quotidien relevé pour ne pas
        // masquer l'effet de playerPlaySlots derrière une substitution de "b".
        maxDailyReservationsPerPlayer: 3,
      }),
    );
    expect(plan.proposedBookings).toHaveLength(3);
    expect(plan.proposedBookings.every((b) => b.userId === "a" && b.partnerId === "b")).toBe(true);
  });
});
