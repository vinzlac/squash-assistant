import type { McpToolError } from "../mcp/client.js";

/**
 * Identification du joueur à sec (2026-10-30). Un refus de quota TeamR ne porte pas de `userId`,
 * mais cite le joueur par son nom (« Joshua JACQUES-PHINERA a utilisé tous ses crédits. ») : on
 * rapproche ce nom du nom complet des deux joueurs de la ligne. Ce module ne fait aucun appel réseau.
 */

export interface NameCandidate {
  id: string;
  firstName: string | null;
  lastName: string | null;
}

/** Nom cité par TeamR : `details.teamr.name`, sinon le sujet de « X a utilisé tous ses crédits ». */
export function refusedPlayerName(error: McpToolError): string | null {
  const teamr = error.details.teamr as { name?: unknown; message?: unknown } | undefined;
  if (typeof teamr?.name === "string" && teamr.name.trim() !== "") return teamr.name.trim();
  const message = typeof teamr?.message === "string" ? teamr.message : error.message;
  return /(?:^|[\s"'])([^"'.:]+?) a utilisé tous ses crédits/i.exec(message)?.[1]?.trim() ?? null;
}

const tokens = (value: string): string[] =>
  value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[\s\-']+/)
    .filter((token) => token !== "");

/**
 * Le nom cité correspond au nom complet quand chacun de ses mots est le début d'un mot du nom
 * complet, dans l'ordre (« Joshua J » ↔ « Joshua JACQUES-PHINERA » ; TeamR abrège parfois le nom).
 */
function matchesFullName(refused: string, firstName: string | null, lastName: string | null): boolean {
  const full = tokens(`${firstName ?? ""} ${lastName ?? ""}`);
  let from = 0;
  const refusedTokens = tokens(refused);
  if (refusedTokens.length === 0) return false;
  for (const token of refusedTokens) {
    const index = full.findIndex((word, i) => i >= from && word.startsWith(token));
    if (index === -1) return false;
    from = index + 1;
  }
  return true;
}

/** `id` du seul candidat dont le nom correspond ; `null` si aucun ou plusieurs (on ne devine pas). */
export function identifyCreditHolder(refusedName: string, candidates: readonly NameCandidate[]): string | null {
  const matches = candidates.filter((c) => matchesFullName(refusedName, c.firstName, c.lastName));
  return matches.length === 1 ? matches[0]!.id : null;
}
