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

export type PairReplacement = {
  replaced: string;
  by: string;
  kind: "substitute" | "joker";
};

export type ResolvedPair = {
  userId: string;
  partnerId: string;
  replacements: PairReplacement[];
};

/**
 * Rend une paire réservable, ou `null` si c'est impossible.
 *
 * Ordre imposé (règle métier 2026-09-01) : **prête-noms d'abord**, joker en dernier recours.
 * Un prête-nom est un vrai joueur du groupe qui prête son nom — on le consomme tant qu'il en
 * reste ; le joker (gérant du club) est illimité, donc il ne doit pas priver le plan d'un
 * prête-nom disponible, mais il évite d'abandonner une paire quand la file est vide.
 *
 * `blockedIds` = joueurs qui ne peuvent pas porter cette ligne, quelle qu'en soit la cause :
 * non réinscrits (resa-squash ADR-011) **ou** au plafond « maison » de résas/jour (ADR-016).
 * Le joker n'est jamais bloqué (pas de plafond, toujours inscrit) et les prête-noms bloqués
 * sont ignorés — un prête-nom non réinscrit ne peut pas réserver non plus.
 *
 * Le joker ne peut occuper que la place de **partenaire** : si c'est le titulaire qui est
 * bloqué, le partenaire (valide) est promu titulaire et le joker prend sa place.
 */
export function resolveBookablePair(input: {
  userId: string;
  partnerId: string;
  blockedIds: ReadonlySet<string>;
  /** File de prête-noms par ordre de priorité — **mutée** à la consommation. */
  substituteQueue: string[];
  jokerBookerId: string | null;
}): ResolvedPair | null {
  const { blockedIds, substituteQueue, jokerBookerId } = input;
  const isBlocked = (id: string) => id !== jokerBookerId && blockedIds.has(id);

  let userId = input.userId;
  let partnerId = input.partnerId;
  const replacements: PairReplacement[] = [];

  // 1. Prête-noms en priorité, sur n'importe quelle place (ce sont des joueurs ordinaires).
  for (const role of ["userId", "partnerId"] as const) {
    const current = role === "userId" ? userId : partnerId;
    if (!isBlocked(current)) continue;

    const index = substituteQueue.findIndex((sub) => !isBlocked(sub) && sub !== userId && sub !== partnerId);
    if (index === -1) continue;
    const sub = substituteQueue.splice(index, 1)[0]!;
    if (role === "userId") userId = sub;
    else partnerId = sub;
    replacements.push({ replaced: current, by: sub, kind: "substitute" });
  }

  // 2. Joker en dernier recours, partenaire uniquement, une seule fois par ligne.
  const stillBlocked = ([...new Set(["userId", "partnerId"])] as Array<"userId" | "partnerId">).filter((role) =>
    isBlocked(role === "userId" ? userId : partnerId),
  );
  if (stillBlocked.length === 0) return { userId, partnerId, replacements };
  if (!jokerBookerId || userId === jokerBookerId || partnerId === jokerBookerId) return null;
  // Le joker ne couvre qu'une place : deux joueurs encore bloqués = paire irrécupérable.
  if (stillBlocked.length > 1) return null;

  if (stillBlocked[0] === "partnerId") {
    replacements.push({ replaced: partnerId, by: jokerBookerId, kind: "joker" });
    partnerId = jokerBookerId;
  } else {
    // Titulaire bloqué : le partenaire (valide) devient titulaire, le joker passe partenaire.
    replacements.push({ replaced: userId, by: jokerBookerId, kind: "joker" });
    userId = partnerId;
    partnerId = jokerBookerId;
  }

  return userId === partnerId ? null : { userId, partnerId, replacements };
}

/**
 * Ligne lisible pour les warnings de plan. `cause` est fournie par l'appelant (lui seul sait
 * pourquoi le joueur était bloqué) — c'est ce que l'organisateur lit dans la synthèse, donc la
 * distinction « pas réinscrit » / « plafond atteint » doit y rester visible.
 */
export function formatPairReplacement(r: PairReplacement, cause: string, slotTime: string): string {
  const by = r.kind === "joker" ? `réservation au nom du joker ${r.by}` : `remplacé par le prête-nom ${r.by}`;
  return `${r.replaced} : ${cause} — ${by} pour cette paire (${slotTime}).`;
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
