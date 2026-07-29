import { describe, expect, it } from "vitest";
import { resolveCourtAssignments, type AvailableSlot, type ProposedSlot } from "./courtAssignment.js";
import type { GroupBookingPair } from "./pairing.js";

function slot(court: number, beginTime = "18H45", endTime = "19H30"): AvailableSlot {
  return { sessionId: `s-${court}-${beginTime}`, court, beginTime, endTime };
}

describe("resolveCourtAssignments", () => {
  it("retourne null si moins de courts disponibles que de paires", () => {
    const result = resolveCourtAssignments(
      [slot(4)],
      [{ userId: "a", partnerId: "b" }, { userId: "c", partnerId: "d" }],
      [],
      [4, 3, 2, 1],
      null,
    );
    expect(result).toBeNull();
  });

  it("respecte courtPriority quand aucune continuité n'est en jeu", () => {
    const result = resolveCourtAssignments(
      [slot(1), slot(3), slot(4)],
      [{ userId: "a", partnerId: "b" }],
      [],
      [4, 3, 2, 1],
      null,
    );
    expect(result).toEqual([{ pair: { userId: "a", partnerId: "b" }, slot: slot(4) }]);
  });

  it("garde le court déjà utilisé par la même paire dans une couche précédente (continuité)", () => {
    const proposedSoFar: ProposedSlot[] = [
      { userId: "a", partnerId: "b", court: 3, slotTime: "18H45", slotEndTime: "19H30" },
    ];
    const result = resolveCourtAssignments(
      [slot(3, "19H30", "20H15"), slot(4, "19H30", "20H15")],
      [{ userId: "a", partnerId: "b" }],
      proposedSoFar,
      [4, 3, 2, 1], // le court 4 est mieux classé, mais la paire doit rester sur le 3 (continuité)
      null,
    );
    expect(result).toEqual([{ pair: { userId: "a", partnerId: "b" }, slot: slot(3, "19H30", "20H15") }]);
  });

  it("préfère un court disponible sur les 2 créneaux successifs à un court mieux classé mais dispo sur un seul", () => {
    // Exemple exact de la doc : courtPriority=[4,3,2,1], le 4 n'est libre que sur ce créneau,
    // le 3 est libre sur ce créneau ET le suivant → le plan retient le 3.
    const result = resolveCourtAssignments(
      [slot(3), slot(4)],
      [{ userId: "a", partnerId: "b" }],
      [],
      [4, 3, 2, 1],
      new Set([3]), // seul le court 3 est aussi dispo au créneau suivant
    );
    expect(result).toEqual([{ pair: { userId: "a", partnerId: "b" }, slot: slot(3) }]);
  });
});
