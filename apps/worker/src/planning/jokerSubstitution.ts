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
 * Le joker se met en **partenaire** (`partnerId`), autant de fois qu'on veut et sur autant de
 * créneaux qu'on veut — y compris plusieurs fois au même horaire — à la seule condition que le
 * **titulaire** (`userId`) soit, lui, bien inscrit. D'où la règle centrale ici : quand c'est le
 * titulaire qui est refusé, on ne le remplace pas par le joker (qui deviendrait titulaire), on
 * **promeut le partenaire en titulaire** et on met le joker en partenaire.
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
 * Remplacements à tenter, dans l'ordre. Le joker occupe **toujours la place de partenaire** :
 * c'est la seule position où il est sans limite, et elle suppose un titulaire bien inscrit.
 *
 * - Le **partenaire** est refusé → le joker le remplace, le titulaire ne bouge pas.
 * - Le **titulaire** est refusé → le partenaire (lui, valide) est **promu titulaire** et le
 *   joker prend la place de partenaire. Remplacer le titulaire par le joker ferait de lui un
 *   titulaire, ce qui sort de son cas d'usage.
 * - **Les deux** sont refusés → aucun titulaire valide sous la main, rien à tenter.
 * - Refus de quota TeamR (aucun fautif désigné) → on tente les deux formes, partenaire d'abord ;
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
  /** Joker en partenaire, titulaire inchangé — valable si le titulaire est inscrit. */
  const replacePartner = { replaced: partnerId, userId, partnerId: jokerBookerId };
  /** Partenaire promu titulaire, joker en partenaire — pour un titulaire refusé. */
  const promotePartner = { replaced: userId, userId: partnerId, partnerId: jokerBookerId };

  if (blamed.size === 0) return [replacePartner, promotePartner];
  if (blamed.has(userId) && blamed.has(partnerId)) return [];
  return blamed.has(partnerId) ? [replacePartner] : [promotePartner];
}

/**
 * Application directe du joker à une paire, au moment du **plan** (pas de la réservation) :
 * on sait déjà qui n'est pas réinscrit (`list_group_members`), donc pas d'essai-erreur — on
 * prend la première forme valable. Retourne `null` s'il n'y a rien à faire (personne de non
 * réinscrit dans la paire) ou rien de faisable (pas de joker, ou les deux joueurs non
 * réinscrits donc aucun titulaire valide).
 */
export function applyJokerToPair(input: {
  userId: string;
  partnerId: string;
  jokerBookerId: string | null;
  unregisteredPlayerIds: ReadonlySet<string>;
}): { replaced: string; userId: string; partnerId: string } | null {
  const blamedIds = [input.userId, input.partnerId].filter((id) => input.unregisteredPlayerIds.has(id));
  if (blamedIds.length === 0) return null;
  return (
    substitutionCandidates({
      userId: input.userId,
      partnerId: input.partnerId,
      jokerBookerId: input.jokerBookerId,
      blamedIds,
    })[0] ?? null
  );
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
