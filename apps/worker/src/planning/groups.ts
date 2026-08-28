import { resolvePlayerPlaySlots, type PlayerPlaySlotsMap, type PlaySlotsDefaults } from "./playerPlaySlots.js";
import { buildPairsForGroupBooking } from "./pairing.js";
import { MAX_PLAYERS_PER_COURT_GROUP } from "./constants.js";

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
 * Construit les groupes (2 ou 3 joueurs) à partir des paires (`buildPairsForGroupBooking`) et d'un
 * nombre cible de groupes (`targetGroupCount`, ≤ `pairs.length` — décidé par l'appelant, cf.
 * `computeGroupBookingPlan`). Quand `pairs.length > targetGroupCount` (plus de paires que de courts
 * disponibles, ex. `unexpectedPlayersMargin` + `preferMinPlayersPerCourt` faisant dépasser `maxCourts`
 * — régression 2026-08-28), les paires en surplus sont dissoutes : leurs membres, plus le joueur en
 * rotation (effectif impair) s'il y en a un, rejoignent en 3e position les groupes les mieux classés
 * (ordre de `pairs`, 1 max par groupe — `MAX_PLAYERS_PER_COURT_GROUP` plafonne la taille d'un groupe
 * quelle que soit la valeur configurée de `maxPlayersPerCourt`, cf. `scheduleGroupTimeline.ts` qui ne
 * sait nommer que des groupes de 2 ou 3). Un joueur en surplus qui ne rejoint aucun groupe (plafond
 * atteint) reste hors plan (warning explicite, aucune ligne TeamR — comme l'ancien mécanisme de
 * couches, cf. sessionExtension.ts).
 */
export function buildGroupsForBooking(
  expected: string[],
  substitutes: string[],
  playSlotsDefaults: PlaySlotsDefaults,
  playerPlaySlots: PlayerPlaySlotsMap,
  maxPlayersPerCourt: number,
  targetGroupCount: number,
): BuildGroupsResult {
  const { pairs, rotatingPlayerIds, remainingSubstituteIds } = buildPairsForGroupBooking(expected, substitutes);
  const warnings: string[] = [];
  const groupCap = Math.min(maxPlayersPerCourt, MAX_PLAYERS_PER_COURT_GROUP);

  const baseGroupPairs = pairs.slice(0, targetGroupCount);
  const excessPairs = pairs.slice(targetGroupCount);
  const overflow = [...excessPairs.flatMap((p) => [p.userId, p.partnerId]), ...rotatingPlayerIds];
  const memberLists: string[][] = baseGroupPairs.map((p) => [p.userId, p.partnerId]);

  overflow.forEach((extra, i) => {
    const group = i < memberLists.length ? memberLists[i]! : undefined;
    if (group && group.length + 1 <= groupCap) {
      group.push(extra);
      warnings.push(
        overflow.length === 1
          ? `Effectif impair : ${extra} intégré au groupe du court le mieux classé (rotation à ${group.length}, les joueurs s'arrangent entre eux pour tourner).`
          : `Effectif surnuméraire : ${extra} intégré au groupe ${i + 1} par ordre de court (rotation à ${group.length}, les joueurs s'arrangent entre eux pour tourner).`,
      );
    } else {
      warnings.push(
        overflow.length === 1
          ? `Effectif impair : rotation sur court sans ligne TeamR pour id(s) : ${extra} (plafond ${maxPlayersPerCourt} joueurs/court — un prête-nom n'est jamais utilisé pour compléter l'effectif).`
          : `Effectif surnuméraire : rotation sur court sans ligne TeamR pour id(s) : ${extra} (plafond ${maxPlayersPerCourt} joueurs/court — un prête-nom n'est jamais utilisé pour compléter l'effectif).`,
      );
    }
  });

  const groups: Group[] = memberLists.map((members) => {
    const ordered = orderMembersByDemand(members, playSlotsDefaults, playerPlaySlots);
    return { members: ordered, roundsNeeded: computeRoundsNeededForMembers(ordered, playSlotsDefaults, playerPlaySlots) };
  });

  return { groups, remainingSubstituteIds, warnings };
}
