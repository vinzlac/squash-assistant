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

/**
 * Nom cité par TeamR : le sujet de « X a utilisé tous ses crédits » (message TeamR, sinon texte de
 * l'erreur MCP). `teamr.name` n'est qu'un repli, et seulement s'il ressemble à un nom de personne
 * (plusieurs mots) : TeamR y met en général un code d'erreur (« noCredits »).
 */
export function refusedPlayerName(error: McpToolError): string | null {
  const teamr = error.details.teamr as { name?: unknown; message?: unknown } | undefined;
  const subject = (text: unknown): string | null =>
    typeof text === "string" ? (/(?:^|[\s"'])([^"'.:]+?) a utilisé tous ses crédits/i.exec(text)?.[1]?.trim() ?? null) : null;
  const fromMessage = subject(teamr?.message) ?? subject(error.message);
  if (fromMessage) return fromMessage;
  const name = typeof teamr?.name === "string" ? teamr.name.trim() : "";
  return /\s/.test(name) ? name : null;
}

const tokens = (value: string): string[] =>
  value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[\s\-']+/)
    .filter((token) => token !== "");

/**
 * Le nom cité correspond au nom complet quand son premier mot est exactement le prénom et que les
 * suivants sont le début d'un mot du nom, dans l'ordre (« Joshua J » ↔ « Joshua JACQUES-PHINERA » ;
 * TeamR abrège parfois le nom de famille, jamais le prénom : « Max » ne désigne pas « Maxime »).
 */
function matchesFullName(refused: string, firstName: string | null, lastName: string | null): boolean {
  const full = tokens(`${firstName ?? ""} ${lastName ?? ""}`);
  const refusedTokens = tokens(refused);
  if (refusedTokens.length === 0 || refusedTokens[0] !== full[0]) return false;
  let from = 1;
  for (const token of refusedTokens.slice(1)) {
    const index = full.findIndex((word, i) => i >= from && word.startsWith(token));
    if (index === -1) return false;
    from = index + 1;
  }
  return true;
}

/**
 * `id` du seul candidat dont le nom correspond ; `null` si aucun ou plusieurs (on ne devine pas).
 * Entre plusieurs correspondances, une correspondance exacte unique l'emporte.
 */
export function identifyCreditHolder(refusedName: string, candidates: readonly NameCandidate[]): string | null {
  const matches = candidates.filter((c) => matchesFullName(refusedName, c.firstName, c.lastName));
  if (matches.length <= 1) return matches[0]?.id ?? null;
  const wanted = tokens(refusedName).join(" ");
  const exact = matches.filter((c) => tokens(`${c.firstName ?? ""} ${c.lastName ?? ""}`).join(" ") === wanted);
  return exact.length === 1 ? exact[0]!.id : null;
}
