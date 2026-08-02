/**
 * Remplace les userId bruts d'un texte libre (warning du moteur de plan, ex.
 * "... pour id(s) : 60be7781b884160020172c3a ...") par "Nom (id)" quand le nom
 * est connu — évite d'afficher des id resa-squash illisibles dans l'UI.
 */
export function resolvePlayerIdsInText(text: string, playerNames: Record<string, string>): string {
  const ids = Object.keys(playerNames).sort((a, b) => b.length - a.length);
  return ids.reduce((acc, id) => acc.split(id).join(`${playerNames[id]} (${id})`), text);
}
