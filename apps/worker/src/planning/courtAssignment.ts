import type { GroupBookingPair } from "./pairing.js";

export interface AvailableSlot {
  sessionId: string;
  court: number;
  beginTime: string;
  endTime: string;
}

export interface ProposedSlot {
  userId: string;
  partnerId: string;
  court: number;
  slotTime: string;
  slotEndTime: string;
  /** Identité réelle de la paire avant substitution prête-nom (continuité de court) — égale à userId/partnerId si aucune substitution n'a eu lieu. */
  pairUserId?: string;
  pairPartnerId?: string;
}

function orderByCourtPriority(slots: AvailableSlot[], courtPriority: number[]): AvailableSlot[] {
  if (!courtPriority || courtPriority.length === 0) return slots;
  const rank = new Map(courtPriority.map((c, i) => [c, i]));
  return [...slots].sort((a, b) => {
    const ra = rank.get(a.court) ?? courtPriority.length + a.court;
    const rb = rank.get(b.court) ?? courtPriority.length + b.court;
    return ra - rb;
  });
}

/**
 * Court utilisé par cette paire (mêmes 2 joueurs, ordre indifférent) dans une couche déjà planifiée.
 * Compare sur l'identité réelle de la paire (pairUserId/pairPartnerId), pas sur l'identité TeamR de
 * la réservation (userId/partnerId) : un prête-nom différent d'un round à l'autre ne doit pas casser
 * la continuité de court d'une même paire réelle.
 */
function previousCourtForPair(proposedSoFar: ProposedSlot[], userId: string, partnerId: string): number | null {
  for (let i = proposedSoFar.length - 1; i >= 0; i -= 1) {
    const b = proposedSoFar[i]!;
    const bUserId = b.pairUserId ?? b.userId;
    const bPartnerId = b.pairPartnerId ?? b.partnerId;
    const samePair =
      (bUserId === userId && bPartnerId === partnerId) || (bUserId === partnerId && bPartnerId === userId);
    if (samePair) return b.court;
  }
  return null;
}

/**
 * Assigne un court à chaque paire du round, en priorisant la continuité de court sur 2 créneaux
 * successifs d'une même résa avant courtPriority :
 * 1. Une paire déjà réservée sur un court dans une couche précédente garde ce court s'il est encore dispo.
 * 2. Pour les paires restantes, si `nextSlotCourts` est fourni, les courts dispo aussi sur le
 *    prochain créneau passent avant ceux dispo seulement maintenant.
 * 3. Le reste suit courtPriority.
 * Retourne null si le nombre de courts distincts disponibles est insuffisant.
 * Port fidèle de resa-squash (group-booking-plan.ts, resolveCourtAssignments).
 */
export function resolveCourtAssignments(
  availableAtTime: AvailableSlot[],
  pairsThisRound: GroupBookingPair[],
  proposedSoFar: ProposedSlot[],
  courtPriority: number[],
  nextSlotCourts: Set<number> | null,
): Array<{ pair: GroupBookingPair; slot: AvailableSlot }> | null {
  if (availableAtTime.length < pairsThisRound.length) return null;

  const byCourt = new Map<number, AvailableSlot>();
  for (const s of availableAtTime) {
    byCourt.set(s.court, s);
  }
  if (byCourt.size < pairsThisRound.length) return null;

  const remainingCourts = new Set(byCourt.keys());
  const assignments = new Array<{ pair: GroupBookingPair; slot: AvailableSlot } | null>(pairsThisRound.length).fill(
    null,
  );

  pairsThisRound.forEach((pr, idx) => {
    const prevCourt = previousCourtForPair(proposedSoFar, pr.userId, pr.partnerId);
    if (prevCourt != null && remainingCourts.has(prevCourt)) {
      assignments[idx] = { pair: pr, slot: byCourt.get(prevCourt)! };
      remainingCourts.delete(prevCourt);
    }
  });

  const rankedByPriority = orderByCourtPriority([...remainingCourts].map((c) => byCourt.get(c)!), courtPriority);
  const remainingSlotsByPriority = nextSlotCourts
    ? [...rankedByPriority].sort((a, b) => {
        const aBoth = nextSlotCourts.has(a.court) ? 0 : 1;
        const bBoth = nextSlotCourts.has(b.court) ? 0 : 1;
        return aBoth - bBoth;
      })
    : rankedByPriority;

  let cursor = 0;
  pairsThisRound.forEach((pr, idx) => {
    if (assignments[idx]) return;
    assignments[idx] = { pair: pr, slot: remainingSlotsByPriority[cursor]! };
    cursor += 1;
  });

  return assignments as Array<{ pair: GroupBookingPair; slot: AvailableSlot }>;
}
