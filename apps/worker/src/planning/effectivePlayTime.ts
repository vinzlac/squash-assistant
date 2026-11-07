import { PLAYERS_PER_BOOKING, SQUASH_SLOT_MINUTES } from "./constants.js";

/** Minutes de jeu effectif par créneau de 45 min quand n joueurs partagent le court (2 jouent à la fois). */
export function effectiveMinutesPerSlot(playerCountOnCourt: number): number {
  if (playerCountOnCourt <= 0) return 0;
  if (playerCountOnCourt <= PLAYERS_PER_BOOKING) return SQUASH_SLOT_MINUTES;
  return SQUASH_SLOT_MINUTES * (PLAYERS_PER_BOOKING / playerCountOnCourt);
}
