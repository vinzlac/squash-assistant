/**
 * plan_group_bookings (MCP resa-squash) constitue les paires dans l'ordre de
 * expectedPlayerIds — mettre les priorityBookers d'une BookingRule en tête
 * fait d'eux les réservataires (1er joueur de chaque paire) en priorité.
 */
export function prioritizePlayers(confirmedPlayerIds: string[], priorityBookers: string[]): string[] {
  const confirmedSet = new Set(confirmedPlayerIds);
  const priorityPresent = priorityBookers.filter((id) => confirmedSet.has(id));
  const prioritySet = new Set(priorityPresent);
  const rest = confirmedPlayerIds.filter((id) => !prioritySet.has(id));
  return [...priorityPresent, ...rest];
}
