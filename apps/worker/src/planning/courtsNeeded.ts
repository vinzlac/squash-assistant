import { MAX_PLAYERS_PER_COURT_GROUP, MIN_PLAYERS_PER_COURT_GROUP } from "./constants.js";

/**
 * Nombre de courts à réserver pour couvrir N joueurs.
 * `preferMin` (défaut false) : true = remplir chaque court au minimum
 * (moins de joueurs/court, plus de courts utilisés simultanément).
 */
export function courtsNeededForPlayers(playerCount: number, preferMin = false): number {
  if (playerCount <= 0) return 0;
  const divisor = preferMin ? MIN_PLAYERS_PER_COURT_GROUP : MAX_PLAYERS_PER_COURT_GROUP;
  if (playerCount <= divisor) return 1;
  return Math.ceil(playerCount / divisor);
}
