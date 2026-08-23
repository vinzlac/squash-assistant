import { resolvePlayerPlaySlots, type PlayerPlaySlotsMap, type PlaySlotsDefaults } from "./playerPlaySlots.js";

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
