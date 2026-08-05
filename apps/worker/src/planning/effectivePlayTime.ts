import { PLAYERS_PER_BOOKING, SQUASH_SLOT_MINUTES } from "./constants.js";

/** Minutes de jeu effectif par créneau de 45 min quand n joueurs partagent le court (2 jouent à la fois). */
export function effectiveMinutesPerSlot(playerCountOnCourt: number): number {
  if (playerCountOnCourt <= 0) return 0;
  if (playerCountOnCourt <= PLAYERS_PER_BOOKING) return SQUASH_SLOT_MINUTES;
  return SQUASH_SLOT_MINUTES * (PLAYERS_PER_BOOKING / playerCountOnCourt);
}

/** Objectif de temps de jeu effectif par joueur (slotsPerPlayer créneaux pleins à 2). */
export function targetEffectiveMinutes(slotsPerPlayer: number): number {
  return slotsPerPlayer * SQUASH_SLOT_MINUTES;
}

/** Créneaux nécessaires depuis l'arrivée d'un joueur pour atteindre le quota effectif. */
export function slotsNeededFromJoin(playerCountOnCourt: number, slotsPerPlayer: number): number {
  const perSlot = effectiveMinutesPerSlot(playerCountOnCourt);
  if (perSlot <= 0) return 0;
  return Math.ceil(targetEffectiveMinutes(slotsPerPlayer) / perSlot);
}
