/**
 * computeGroupBookingPlan (moteur local, planning/groupBookingPlan.ts) constitue les
 * paires en prenant les joueurs 2 par 2 dans l'ordre de expectedPlayerIds (indices
 * [0,1], [2,3], ...), chaque paire allant sur un court distinct. Si deux
 * priorityBookers confirmés se retrouvaient consécutifs en tête de liste, ils
 * seraient donc appariés ensemble sur le même court — hors de la règle métier
 * (1 seul réservataire prioritaire par court). On intercale un joueur non
 * prioritaire après chaque priorityBooker pour que chacun reste le 1er joueur
 * (donc le réservataire) d'une paire séparée.
 */
export function prioritizePlayers(confirmedPlayerIds: string[], priorityBookers: string[]): string[] {
  const confirmedSet = new Set(confirmedPlayerIds);
  const priorityPresent = [...new Set(priorityBookers)].filter((id) => confirmedSet.has(id));
  const prioritySet = new Set(priorityPresent);
  const rest = confirmedPlayerIds.filter((id) => !prioritySet.has(id));

  const result: string[] = [];
  let restIndex = 0;
  for (const bookerId of priorityPresent) {
    result.push(bookerId);
    if (restIndex < rest.length) {
      result.push(rest[restIndex]!);
      restIndex += 1;
    }
  }
  result.push(...rest.slice(restIndex));
  return result;
}
