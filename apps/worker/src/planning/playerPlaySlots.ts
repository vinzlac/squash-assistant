/** Quotas de temps de jeu effectif (créneaux de 45 min). */
export interface PlayerPlaySlots {
  minSlots: number;
  maxSlots: number;
}

export interface PlaySlotsDefaults {
  defaultMinPlaySlots: number;
  defaultMaxPlaySlots: number;
}

export type PlayerPlaySlotsMap = ReadonlyMap<string, PlayerPlaySlots>;

export const DEFAULT_PLAY_SLOTS: PlaySlotsDefaults = {
  defaultMinPlaySlots: 2,
  defaultMaxPlaySlots: 2,
};

/**
 * Résout min/max effectifs pour un joueur : surcharge `player_preferences` sinon défauts globaux.
 * Clamp applicatif 1..6 et min ≤ max.
 */
export function resolvePlayerPlaySlots(
  userId: string,
  defaults: PlaySlotsDefaults,
  overrides: ReadonlyMap<string, PlayerPlaySlots> | Readonly<Record<string, PlayerPlaySlots>>,
): PlayerPlaySlots {
  const fromMap = overrides instanceof Map ? overrides.get(userId) : (overrides as Readonly<Record<string, PlayerPlaySlots>>)[userId];
  const rawMin = fromMap?.minSlots ?? defaults.defaultMinPlaySlots;
  const rawMax = fromMap?.maxSlots ?? defaults.defaultMaxPlaySlots;
  const minSlots = Math.min(6, Math.max(1, Math.floor(rawMin)));
  const maxSlots = Math.min(6, Math.max(minSlots, Math.floor(rawMax)));
  return { minSlots, maxSlots };
}

/** Construit une map pour tous les ids connus (confirmés + overrides), avec résolution. */
export function buildPlayerPlaySlotsMap(
  playerIds: Iterable<string>,
  defaults: PlaySlotsDefaults,
  overrides: ReadonlyMap<string, PlayerPlaySlots> | Readonly<Record<string, PlayerPlaySlots>>,
): Map<string, PlayerPlaySlots> {
  const result = new Map<string, PlayerPlaySlots>();
  for (const id of playerIds) {
    result.set(id, resolvePlayerPlaySlots(id, defaults, overrides));
  }
  return result;
}
