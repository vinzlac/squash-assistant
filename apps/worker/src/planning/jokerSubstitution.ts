/**
 * Joker de réservation (ADR-024).
 *
 * resa-squash refuse un `reserve_slot` avec un `reason` stable quand un joueur ne peut pas
 * réserver : pas réinscrit pour la saison (`PLAYER_NOT_REGISTERED`, resa-squash ADR-011) ou
 * quota / crédits TeamR épuisés (`PLAYER_BOOKING_LIMIT_REACHED`). Plutôt que de faire échouer
 * tout le lot — et donc de rouler en arrière des réservations déjà faites — on remplace le
 * joueur fautif par le **joker** de la règle : le gérant du club, sans plafond et toujours
 * réinscrit. Le joueur réel joue quand même, seul le nom porté par TeamR change (même
 * sémantique qu'un prête-nom, `substituteBookers`).
 *
 * Ce module ne fait aucun appel réseau : il décide *qui* remplacer et *par qui*.
 */

/** Refus qui se traite par substitution — les autres (créneau déjà pris, refus inconnu) non. */
const SUBSTITUTABLE_REASONS = new Set(["PLAYER_NOT_REGISTERED", "PLAYER_BOOKING_LIMIT_REACHED"]);

export function isSubstitutableReason(reason: string | null | undefined): boolean {
  return reason != null && SUBSTITUTABLE_REASONS.has(reason);
}

/**
 * Joueurs explicitement désignés par resa-squash comme cause du refus
 * (`details.players[].userId`). Renseigné pour `PLAYER_NOT_REGISTERED` ; absent pour un refus
 * TeamR de quota, où le message ne dit pas lequel des deux joueurs est en cause.
 */
export function blamedPlayerIds(details: Record<string, unknown> | undefined): string[] {
  const players = details?.players;
  if (!Array.isArray(players)) return [];
  return players
    .map((p) => (p as { userId?: unknown })?.userId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export interface SubstitutionCandidateInput {
  userId: string;
  partnerId: string;
  /** userId du joker configuré sur la règle, ou null si la règle n'en définit pas. */
  jokerBookerId: string | null;
  /** Joueurs désignés par resa-squash, s'il les connaît. */
  blamedIds: string[];
}

/**
 * Remplacements à tenter, dans l'ordre. Chaque candidat remplace **un seul** des deux noms :
 * une réservation joker + joker n'a pas de sens (une même personne ne peut pas occuper les
 * deux places d'un court).
 *
 * - resa-squash désigne le fautif → on ne tente que celui-là.
 * - refus de quota TeamR (aucun fautif désigné) → on tente le partenaire puis le titulaire ;
 *   `reserve_slot` étant atomique, un essai infructueux ne laisse rien derrière lui.
 */
export function substitutionCandidates(
  input: SubstitutionCandidateInput,
): Array<{ replaced: string; userId: string; partnerId: string }> {
  const { userId, partnerId, jokerBookerId, blamedIds } = input;
  if (!jokerBookerId) return [];
  // Le joker est déjà sur cette ligne : le remplacer par lui-même ne changerait rien.
  if (userId === jokerBookerId || partnerId === jokerBookerId) return [];

  const blamed = new Set(blamedIds);
  const targets = blamed.size > 0 ? [userId, partnerId].filter((id) => blamed.has(id)) : [partnerId, userId];

  return targets.map((target) => ({
    replaced: target,
    userId: target === userId ? jokerBookerId : userId,
    partnerId: target === partnerId ? jokerBookerId : partnerId,
  }));
}

/**
 * Le joker ne peut pas être sur deux courts au même horaire : une fois utilisé à `slotTime`,
 * il n'est plus substituable pour les autres réservations de ce même créneau. Il redevient
 * disponible à l'horaire suivant — c'est ce qui le distingue d'un `substituteBookers`,
 * consommé pour la journée entière.
 */
export class JokerAvailability {
  private readonly usedAt = new Set<string>();

  constructor(private readonly jokerBookerId: string | null) {}

  isAvailableAt(slotTime: string): boolean {
    return this.jokerBookerId != null && !this.usedAt.has(slotTime);
  }

  markUsedAt(slotTime: string): void {
    this.usedAt.add(slotTime);
  }
}

export interface JokerSubstitution {
  sessionId: string;
  slotTime: string;
  replacedUserId: string;
  jokerBookerId: string;
  reason: string;
}

/** Ligne lisible pour Telegram / la synthèse WhatsApp. */
export function formatSubstitution(
  substitution: JokerSubstitution,
  displayName: (userId: string) => string,
): string {
  const motif =
    substitution.reason === "PLAYER_NOT_REGISTERED"
      ? "pas réinscrit pour la saison"
      : "quota de réservations atteint";
  return `${substitution.slotTime} : ${displayName(substitution.replacedUserId)} (${motif}) → réservé au nom de ${displayName(substitution.jokerBookerId)}`;
}
