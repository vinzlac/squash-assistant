export interface GroupBookingPair {
  userId: string;
  partnerId: string;
}

export interface BuildPairsResult {
  pairs: GroupBookingPair[];
  /** Sans prête-nom et effectif impair : dernier joueur (ordre conservé, dédoublonné) sans paire TeamR. */
  rotatingPlayerIds: string[];
  /** Prête-noms non consommés par l'appariement d'effectif impair — réutilisables pour le quota titulaire. */
  remainingSubstituteIds: string[];
}

/**
 * Constitue les paires pour reserve_slot (2 noms / résa).
 * - Effectif pair : tout le monde est apparié.
 * - Effectif impair + prête-noms disponibles : le dernier joueur est apparié au 1er prête-nom.
 * - Effectif impair sans prête-nom : le dernier id unique tourne (rotatingPlayerIds), hors TeamR pour ce plan.
 * Port fidèle de resa-squash (group-booking-plan.ts, buildPairsForGroupBooking).
 */
export function buildPairsForGroupBooking(expected: string[], substitutes: string[]): BuildPairsResult {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of expected.map(String).filter(Boolean)) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }

  if (ordered.length < 2) {
    throw new Error("NEED_AT_LEAST_TWO_PLAYERS");
  }

  const subsQueue = [...new Set(substitutes.map(String).filter(Boolean))];
  const rotatingPlayerIds: string[] = [];
  const work = [...ordered];

  if (work.length % 2 === 1) {
    if (subsQueue.length > 0) {
      const sub = subsQueue.shift()!;
      work.push(sub);
    } else {
      const rotator = work.pop();
      if (rotator !== undefined) {
        rotatingPlayerIds.push(rotator);
      }
    }
  }

  const pairs: GroupBookingPair[] = [];
  const q = [...work];
  while (q.length >= 2) {
    pairs.push({ userId: q.shift()!, partnerId: q.shift()! });
  }

  return { pairs, rotatingPlayerIds, remainingSubstituteIds: subsQueue };
}
