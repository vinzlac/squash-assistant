/**
 * Noms de joueurs resa-squash (règles fonctionnelles §7 « Noms vs identifiants », décision 2026-10-09).
 * `nickname` est optionnel : un serveur MCP resa-squash antérieur au pseudo ne le renvoie pas.
 */
export interface PlayerNameParts {
  nickname?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * Nom d'un joueur dans un message WhatsApp ou Telegram : le pseudo, sinon le prénom seul — jamais le
 * nom de famille. Chaîne vide si aucun des deux : chaque message applique alors son propre repli.
 */
export function playerMessageName(player: PlayerNameParts): string {
  return player.nickname?.trim() || player.firstName?.trim() || "";
}

/**
 * Libellé d'un joueur dans l'UI admin : « Pseudo (Prénom NOM) » (même règle que `playerOptionLabel`
 * de resa-squash) — le prénom tient lieu de pseudo s'il n'y en a pas ; sans nom complet, le pseudo seul.
 */
export function playerAdminLabel(player: PlayerNameParts): string {
  const pseudo = playerMessageName(player);
  const fullName = `${player.firstName?.trim() ?? ""} ${player.lastName?.trim().toUpperCase() ?? ""}`.trim();
  if (!pseudo) return fullName;
  if (!fullName) return pseudo;
  return `${pseudo} (${fullName})`;
}
