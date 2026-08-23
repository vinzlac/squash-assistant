import { resolvePlayerPlaySlots, type PlayerPlaySlotsMap, type PlaySlotsDefaults } from "./playerPlaySlots.js";
import { buildPairsForGroupBooking } from "./pairing.js";

export interface Group {
  /**
   * 2 joueurs (paire classique) ou 3 (paire + joueur en rotation fusionné).
   * Pour un groupe de 3, ordonné par `minSlots` décroissant (position 0 = le
   * plus exigeant) — l'ordre conditionne `computeRoundsNeededForMembers` et
   * le nommage TeamR par round (`teamrNamesForRound`), qui indexent tous les
   * deux `members`.
   */
  members: string[];
  /** Nombre de rounds de 45 min à réserver sur le court de ce groupe. */
  roundsNeeded: number;
}

/**
 * Index dans `members` des 2 joueurs nommés sur la ligne TeamR pour un round donné du groupe.
 * Le moteur ne calcule pas qui est physiquement présent à quel round — les joueurs s'arrangent
 * entre eux une fois le court réservé (simplification actée 2026-08-23) ; ce cycle fixe garantit
 * seulement que chaque duo apparaît une fois par cycle complet de 3 rounds.
 */
export function teamrNamesForRound(groupSize: 2 | 3, roundIndex: number): [number, number] {
  if (groupSize === 2) return [0, 1];
  const cycle: Array<[number, number]> = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  return cycle[roundIndex % 3]!;
}

/**
 * Pour un groupe de 3, trie par `minSlots` décroissant — position 0 = le plus exigeant. Le cycle
 * round-robin fixe de `teamrNamesForRound` ne donne pas le même rythme d'apparition aux 3
 * positions sur un cycle incomplet (positions 0 et 1 rattrapent leur quota plus vite que la
 * position 2) : mettre le membre le plus exigeant en position 0 minimise le nombre de rounds
 * nécessaires. Pour 2 joueurs ou moins, ordre inchangé (les 2 jouent toujours ensemble).
 */
export function orderMembersByDemand(
  members: string[],
  playSlotsDefaults: PlaySlotsDefaults,
  playerPlaySlots: PlayerPlaySlotsMap,
): string[] {
  if (members.length <= 2) return members;
  return [...members].sort(
    (a, b) =>
      resolvePlayerPlaySlots(b, playSlotsDefaults, playerPlaySlots).minSlots -
      resolvePlayerPlaySlots(a, playSlotsDefaults, playerPlaySlots).minSlots,
  );
}

/**
 * Nombre de rounds à réserver pour que chaque membre du groupe atteigne son `minSlots` individuel
 * (`resolvePlayerPlaySlots`, préférences `/players`). Pas de suivi de présence round par round —
 * simulation du cycle round-robin fixe (`teamrNamesForRound`) jusqu'à ce que chaque position ait
 * atteint son quota. `orderedMembers` doit déjà être trié (voir `orderMembersByDemand`) pour un
 * groupe de 3 : mettre le plus exigeant en position 0 minimise le nombre de rounds.
 */
export function computeRoundsNeededForMembers(
  orderedMembers: string[],
  playSlotsDefaults: PlaySlotsDefaults,
  playerPlaySlots: PlayerPlaySlotsMap,
): number {
  const targets = orderedMembers.map((m) => resolvePlayerPlaySlots(m, playSlotsDefaults, playerPlaySlots).minSlots);
  if (orderedMembers.length <= 2) return Math.max(...targets);

  const cycle: Array<[number, number]> = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  const counts = [0, 0, 0];
  let rounds = 0;
  while (counts[0]! < targets[0]! || counts[1]! < targets[1]! || counts[2]! < targets[2]!) {
    const [a, b] = cycle[rounds % 3]!;
    counts[a] += 1;
    counts[b] += 1;
    rounds += 1;
  }
  return rounds;
}

export interface BuildGroupsResult {
  groups: Group[];
  /** Prête-noms disponibles pour le contrôle de plafond de résas/jour (groupBookingPlan.ts). */
  remainingSubstituteIds: string[];
  warnings: string[];
}

/**
 * Construit les groupes (2 ou 3 joueurs) à partir des paires (`buildPairsForGroupBooking`) : le
 * joueur en rotation (effectif impair, jamais plus d'un) rejoint le 1er groupe — court le mieux
 * classé en `courtPriority` (choix simple et déterministe, cf. spec §9).
 */
export function buildGroupsForBooking(
  expected: string[],
  substitutes: string[],
  playSlotsDefaults: PlaySlotsDefaults,
  playerPlaySlots: PlayerPlaySlotsMap,
): BuildGroupsResult {
  const { pairs, rotatingPlayerIds, remainingSubstituteIds } = buildPairsForGroupBooking(expected, substitutes);
  const warnings: string[] = [];
  const memberLists: string[][] = pairs.map((p) => [p.userId, p.partnerId]);

  if (rotatingPlayerIds.length > 0) {
    const rotator = rotatingPlayerIds[0]!;
    memberLists[0] = orderMembersByDemand([...memberLists[0]!, rotator], playSlotsDefaults, playerPlaySlots);
    warnings.push(
      `Effectif impair : ${rotator} intégré au groupe du court le mieux classé (rotation à ${memberLists[0].length}, les joueurs s'arrangent entre eux pour tourner).`,
    );
  }

  const groups: Group[] = memberLists.map((members) => ({
    members,
    roundsNeeded: computeRoundsNeededForMembers(members, playSlotsDefaults, playerPlaySlots),
  }));

  return { groups, remainingSubstituteIds, warnings };
}
