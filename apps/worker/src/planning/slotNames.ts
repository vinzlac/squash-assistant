/**
 * Attribution des noms TeamR aux lignes d'un plan créneau par créneau (ADR-039, point 4).
 *
 * Une ligne = une réservation de 45 min sur un court, au nom de 2 personnes distinctes. Les noms
 * sont administratifs (les joueurs se répartissent physiquement comme ils veulent) mais TeamR
 * impose : 2 noms distincts, une personne au plus une fois par créneau, et un nombre de lignes
 * par personne et par jour borné (`maxDailyReservationsPerPlayer`). Ordre de préférence : les
 * joueurs du court, puis les autres joueurs présents à ce créneau, puis les prête-noms, puis le
 * joker (partenaire uniquement, sans plafond — ADR-024). Recherche exhaustive bornée : les
 * effectifs (≤ ~12 lignes, ~10 noms) restent petits.
 */

export interface LineToName {
  slotTime: string;
  /** Joueurs physiquement sur ce court à ce créneau. */
  onCourt: readonly string[];
  /** Joueurs présents au club à ce créneau (arrivés), tous courts confondus. */
  present: readonly string[];
}

export interface NamePool {
  /** Crédits restants par joueur réel (0 pour un joueur non réinscrit ou exclu). */
  playerCredits: ReadonlyMap<string, number>;
  /** Prête-noms dans l'ordre de priorité, avec leurs crédits. */
  lenders: ReadonlyArray<{ id: string; credits: number }>;
  /** Joker utilisable sur ces lignes (null = non autorisé). */
  jokerId: string | null;
  /** Ordre de priorité des titulaires (réservataires prioritaires de la règle). */
  priorityBookers: readonly string[];
}

export interface NamedLine {
  userId: string;
  partnerId: string;
}

/** Garde-fou contre l'explosion combinatoire : au-delà, la recherche est déclarée infructueuse. */
const MAX_SEARCH_STEPS = 200_000;

const TIER_ON_COURT = 0;
const TIER_PRESENT = 1;
const TIER_LENDER = 2;
const TIER_JOKER = 3;

interface Candidate {
  id: string;
  tier: number;
}

export function assignNames(lines: readonly LineToName[], pool: NamePool): NamedLine[] | null {
  const credits = new Map<string, number>(pool.playerCredits);
  for (const lender of pool.lenders) credits.set(lender.id, (credits.get(lender.id) ?? 0) + lender.credits);
  const lenderOrder = new Map(pool.lenders.map((l, i) => [l.id, i]));
  const isLender = (id: string) => lenderOrder.has(id) && !pool.playerCredits.has(id);
  const usedAtSlot = new Map<string, Set<string>>();
  const result: NamedLine[] = [];
  let steps = 0;

  const remainingCredit = (id: string) => (id === pool.jokerId ? Number.POSITIVE_INFINITY : credits.get(id) ?? 0);

  const enoughCapacity = (from: number): boolean => {
    const remainingLines = lines.length - from;
    if (remainingLines === 0) return true;
    if (pool.jokerId) return true;
    let capacity = 0;
    for (const [, c] of credits) capacity += Math.min(c, remainingLines);
    return capacity >= 2 * remainingLines;
  };

  const priorityRank = (id: string) => {
    const i = pool.priorityBookers.indexOf(id);
    return i < 0 ? pool.priorityBookers.length : i;
  };

  const candidatesFor = (line: LineToName): Candidate[] => {
    const used = usedAtSlot.get(line.slotTime) ?? new Set<string>();
    const out: Candidate[] = [];
    const seen = new Set<string>();
    const push = (id: string, tier: number) => {
      // Le joker peut porter plusieurs courts au même horaire (règle : sans limite, ADR-024).
      if (seen.has(id) || (used.has(id) && id !== pool.jokerId) || remainingCredit(id) <= 0) return;
      seen.add(id);
      out.push({ id, tier });
    };
    const byPreference = (ids: readonly string[]) =>
      [...ids].sort((a, b) => priorityRank(a) - priorityRank(b) || remainingCredit(b) - remainingCredit(a));
    for (const id of byPreference(line.onCourt)) if (!isLender(id)) push(id, TIER_ON_COURT);
    for (const id of byPreference(line.present)) if (!isLender(id)) push(id, TIER_PRESENT);
    for (const lender of pool.lenders) push(lender.id, TIER_LENDER);
    if (pool.jokerId) push(pool.jokerId, TIER_JOKER);
    return out;
  };

  const pairsFor = (line: LineToName): Array<[Candidate, Candidate]> => {
    const cands = candidatesFor(line);
    const pairs: Array<[Candidate, Candidate, number]> = [];
    for (let i = 0; i < cands.length; i += 1) {
      for (let j = i + 1; j < cands.length; j += 1) {
        const a = cands[i]!;
        const b = cands[j]!;
        if (a.id === pool.jokerId && b.id === pool.jokerId) continue;
        pairs.push([a, b, i * cands.length + j]);
      }
    }
    pairs.sort(
      ([a1, b1, o1], [a2, b2, o2]) =>
        Math.max(a1.tier, b1.tier) - Math.max(a2.tier, b2.tier) || a1.tier + b1.tier - (a2.tier + b2.tier) || o1 - o2,
    );
    return pairs.map(([a, b]) => [a, b]);
  };

  const take = (id: string, slotTime: string, delta: number) => {
    if (id !== pool.jokerId) credits.set(id, (credits.get(id) ?? 0) - delta);
    const used = usedAtSlot.get(slotTime) ?? new Set<string>();
    if (delta > 0) used.add(id);
    else used.delete(id);
    usedAtSlot.set(slotTime, used);
  };

  const search = (index: number): boolean => {
    if (index === lines.length) return true;
    steps += 1;
    if (steps > MAX_SEARCH_STEPS || !enoughCapacity(index)) return false;
    const line = lines[index]!;
    for (const [a, b] of pairsFor(line)) {
      take(a.id, line.slotTime, 1);
      take(b.id, line.slotTime, 1);
      // Le joker reste partenaire : l'autre nom devient titulaire.
      const userId = b.id === pool.jokerId ? a.id : a.id === pool.jokerId ? b.id : a.id;
      const partnerId = userId === a.id ? b.id : a.id;
      result.push({ userId, partnerId });
      if (search(index + 1)) return true;
      result.pop();
      take(a.id, line.slotTime, -1);
      take(b.id, line.slotTime, -1);
    }
    return false;
  };

  return search(0) ? [...result] : null;
}
