export interface GroupBookingPair {
  userId: string;
  partnerId: string;
}

export interface BuildPairsResult {
  pairs: GroupBookingPair[];
  /** Effectif impair : dernier joueur (ordre conservé, dédoublonné) sans paire TeamR. */
  rotatingPlayerIds: string[];
  /** Prête-noms passés en entrée, dédoublonnés — jamais consommés par l'appariement, réutilisables pour le plafond de résas/jour. */
  remainingSubstituteIds: string[];
}

/**
 * Constitue les paires pour reserve_slot (2 noms / résa).
 * - Effectif pair : tout le monde est apparié.
 * - Effectif impair : le dernier id unique tourne (rotatingPlayerIds), hors TeamR pour ce plan.
 * Un prête-nom n'est jamais utilisé pour compléter un effectif impair (règle 2026-08-02) — un
 * prête-nom ne vient pas jouer, l'utiliser réserverait un court pour quelqu'un d'absent. Les
 * prête-noms restent disponibles pour le contrôle de plafond de résas/jour (groupBookingPlan.ts).
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

  const remainingSubstituteIds = [...new Set(substitutes.map(String).filter(Boolean))];
  const rotatingPlayerIds: string[] = [];
  const work = [...ordered];

  if (work.length % 2 === 1) {
    const rotator = work.pop();
    if (rotator !== undefined) {
      rotatingPlayerIds.push(rotator);
    }
  }

  const pairs: GroupBookingPair[] = [];
  const q = [...work];
  while (q.length >= 2) {
    pairs.push({ userId: q.shift()!, partnerId: q.shift()! });
  }

  return { pairs, rotatingPlayerIds, remainingSubstituteIds };
}
