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

  it("effectif impair sans prête-nom : rotation, warning explicite, joueur en rotation absent des proposedBookings", () => {
    const availableSlots = [...makeSlots([4], "18H45", "19H30"), ...makeSlots([4], "19H30", "20H15")];
    const plan = computeGroupBookingPlan(
      baseInput({ expectedPlayerIds: ["a", "b", "c"], availableSlots, maxCourts: 1 }),
    );
    expect(plan.meta.rotatingPlayerIds).toEqual(["c"]);
    expect(plan.proposedBookings.some((b) => b.userId === "c" || b.partnerId === "c")).toBe(false);
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
        slotsPerPlayer: 3, // vincent apparaîtrait 3 fois, au-delà du plafond de 2 s'il n'était pas exempté.
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
});
