/**
 * Les notes du moteur de plan (`planning/*.ts`) sont produites sans accès à l'annuaire du
 * groupe : elles citent les joueurs par leur id resa-squash brut (ex. "... pour id(s) :
 * 60be7781b884160020172c3a ..."). Cette fonction les rend lisibles au moment de l'envoi
 * (Telegram, synthèse WhatsApp) en remplaçant chaque id connu par son nom.
 *
 * Pendant de `apps/ui/src/lib/formatWarning.ts`, qui affiche "Nom (id)" : dans l'UI l'id reste
 * utile pour le debug, dans un message envoyé à des joueurs il n'est que du bruit.
 * Un id absent de l'annuaire est laissé tel quel, comme le `displayName` des nœuds du graphe.
 */
export function resolvePlayerIdsInText(text: string, playerNames: Record<string, string>): string {
  const ids = Object.keys(playerNames).sort((a, b) => b.length - a.length);
  return ids.reduce((acc, id) => acc.split(id).join(playerNames[id]!), text);
}
