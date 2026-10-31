import type { BookingRule } from "@squash-assistant/db/schema";
import { getBookingRuleById } from "../../bookingRules.js";
import {
  reserveSlot,
  listGroupMembers,
  listMyFavorites,
  type Favorite,
} from "../../mcp/resaSquash.js";
import { sendMessage } from "../../mcp/huddleBot.js";
import { McpToolError, type McpConnection } from "../../mcp/client.js";
import {
  blamedPlayerIds,
  bookingSubstitutionCandidates,
  formatSubstitution,
  isSubstitutableReason,
  type JokerSubstitution,
} from "../../planning/jokerSubstitution.js";
import { identifyCreditHolder, refusedPlayerName, type NameCandidate } from "../../planning/creditHolder.js";
import { formatMergedCourtSlots, mergeContiguousSlotsByCourt } from "../slotMerge.js";
import { sendBookingQrCodes } from "../bookingQr.js";
import { countUnbookedConfirmedPlayers, reservedBookings } from "../unbookedPlayers.js";
import { buildAnnounceNotes } from "../announceNotes.js";
import { pinBestEffort } from "../pinning.js";
import { getJobRunById, setJobRunAnnounceInfo } from "../../jobRuns.js";
import { publishFinalRoster } from "../../roster/finalRoster.js";
import { resolvePlayerIdsInText } from "../formatWarning.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { emitEvent, withEventLogging } from "../emitEvent.js";
import type { GraphDependencies } from "../dependencies.js";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "./pollQuestion.js";
import { publicVoterName } from "./registrationRecap.js";
import type { BookingPlanGroup, PipelineStateType, ReservationFailure, UnresolvedVoter } from "../state.js";
import { playerMessageName } from "@squash-assistant/db/playerLabel";

/** Résultat d'un lot de réservations réelles : ce qui a été substitué au joker, et ce qui a été refusé. */
export interface RealBookingOutcome {
  substitutions: JokerSubstitution[];
  failures: ReservationFailure[];
}

/** Libellés joueurs des codes de refus resa-squash connus — jamais le texte brut. */
const REFUSAL_LABELS: Record<string, string> = {
  PLAYER_NOT_REGISTERED: "joueur pas réinscrit pour la saison",
  PLAYER_BOOKING_LIMIT_REACHED: "quota de réservations TeamR atteint",
  SLOT_ALREADY_BOOKED: "créneau déjà pris",
};
const GENERIC_REFUSAL_LABEL = "erreur technique, contactez l'organisateur";

/**
 * Motif lisible d'un refus `reserve_slot`, pour les joueurs (WhatsApp) : le message TeamR
 * transmis par resa-squash quand il existe (« X a utilisé tous ses crédits… »), sinon un
 * libellé du code de refus, sinon un motif générique. Le texte brut (`rawError`) ne sert qu'à
 * Telegram / la DB / l'UI — il ne doit jamais atteindre les joueurs (règles fonctionnelles §6).
 */
function describeRefusal(err: unknown): Pick<ReservationFailure, "reason" | "message" | "rawError"> {
  const rawError = err instanceof Error ? err.message : String(err);
  if (!(err instanceof McpToolError)) return { reason: null, message: GENERIC_REFUSAL_LABEL, rawError };
  const teamr = err.details.teamr as { message?: unknown } | undefined;
  const teamrMessage = typeof teamr?.message === "string" ? teamr.message.trim() : "";
  const label = err.reason ? REFUSAL_LABELS[err.reason] : undefined;
  return { reason: err.reason, message: teamrMessage || label || GENERIC_REFUSAL_LABEL, rawError };
}

/**
 * File de prête-noms pour la réservation réelle, dans l'ordre du plan (ADR-017) : volontaires
 * du sondage d'abord, puis prête-noms de la règle, sans doublon.
 */
export function bookingSubstituteQueue(volunteerIds: readonly string[], ruleSubstituteIds: readonly string[]): string[] {
  return [...new Set([...volunteerIds, ...ruleSubstituteIds])];
}

/** Bloc « Non réservé » (une ligne par créneau refusé), ou chaîne vide s'il n'y a aucun refus. */
function formatFailuresBlock(failures: ReservationFailure[], describe: (f: ReservationFailure) => string): string {
  if (failures.length === 0) return "";
  return `\n\n⚠️ Non réservé :\n${failures.map((f) => `• ${f.slotTime}-${f.slotEndTime} (court ${f.court}) — ${describe(f)}`).join("\n")}`;
}

/**
 * Destinataire WhatsApp de l'annonce de réservation.
 * `reservationNotifyWhatsappGroupJid` null/absent → groupe du sondage (`whatsappGroupJid`).
 * Snapshots de jobs antérieurs à ce champ : absents → même repli.
 */
export function resolveReservationNotifyJid(
  rule: Pick<BookingRule, "whatsappGroupJid"> & {
    reservationNotifyWhatsappGroupJid?: string | null;
  },
): string {
  const override = rule.reservationNotifyWhatsappGroupJid?.trim();
  return override || rule.whatsappGroupJid;
}

/**
 * Destinataire WhatsApp de la confirmation du jour J et de ses QR (étape 5, ADR-035) —
 * réglage indépendant de l'annonce. `confirmationNotifyWhatsappGroupJid` null/absent/blanc →
 * groupe du sondage (`whatsappGroupJid`).
 */
export function resolveConfirmationNotifyJid(
  rule: Pick<BookingRule, "whatsappGroupJid"> & {
    confirmationNotifyWhatsappGroupJid?: string | null;
  },
): string {
  const override = rule.confirmationNotifyWhatsappGroupJid?.trim();
  return override || rule.whatsappGroupJid;
}

/**
 * Relit la règle live pour le joker (ADR-024). Comme le destinataire d'annonce, c'est un
 * réglage **opérationnel** : configurer un joker doit prendre effet sur les jobs déjà en cours,
 * pas seulement sur les suivants. L'état du graphe fige `bookingRule` au lancement du sondage
 * (étape 1) et les étapes 3/4 reprennent depuis le checkpoint — sans cette relecture, un joker
 * ajouté après l'envoi du sondage resterait ignoré toute la semaine du job.
 *
 * `live` trouvée → son champ fait foi même s'il vaut explicitement `null` (joker retiré depuis
 * la création du job). Repli sur le snapshot uniquement si la règle live est introuvable.
 */
export async function resolveLiveJokerBookerId(
  deps: GraphDependencies,
  bookingRule: BookingRule,
): Promise<string | null> {
  const live = await getBookingRuleById(deps.db, bookingRule.id).catch(() => undefined);
  return live ? live.jokerBookerId : bookingRule.jokerBookerId;
}

/**
 * Relit la règle live pour le destinataire d'annonce : ce réglage opérationnel
 * (ex. bascule vers Vincent All pendant un essai) doit s'appliquer même si le
 * job a été créé avant la modification — contrairement aux paramètres de plan
 * figés dans `ruleSnapshot` / l'état du graphe.
 */
export async function resolveAnnounceNotifyJid(
  deps: GraphDependencies,
  bookingRule: BookingRule,
): Promise<string> {
  const live = await getBookingRuleById(deps.db, bookingRule.id);
  return resolveReservationNotifyJid({
    whatsappGroupJid: bookingRule.whatsappGroupJid,
    // `live` trouvée → son champ fait foi même s'il vaut explicitement null (override retiré
    // depuis la création du job) : `live?.field ?? bookingRule.field` traiterait ce null comme
    // "absent" et retomberait à tort sur le snapshot figé. Repli sur le snapshot seulement si
    // la règle live est introuvable (`live` undefined).
    reservationNotifyWhatsappGroupJid: live
      ? live.reservationNotifyWhatsappGroupJid
      : bookingRule.reservationNotifyWhatsappGroupJid,
  });
}

/**
 * Réserve réellement chaque créneau proposé (reserve_slot, séquentiel).
 *
 * Si resa-squash refuse parce qu'un joueur ne peut pas réserver (pas réinscrit, ou quota
 * atteint), on retente la même ligne avec le **joker** de la règle en partenaire plutôt que de
 * faire échouer tout le lot (ADR-024) — sans limite de nombre : le joker est réutilisable
 * autant de fois qu'il le faut, y compris au même horaire. Les substitutions effectuées sont
 * retournées pour être signalées à l'organisateur — le nom porté par TeamR n'est alors pas
 * celui du joueur réel.
 *
 * **Pas de tout-ou-rien (2026-09-09, ADR-027).** Un refus non rattrapable n'annule pas les
 * réservations déjà passées et n'empêche pas de tenter les lignes suivantes : chaque ligne est
 * indépendante côté TeamR, et un court pris vaut mieux qu'une soirée entière perdue (incident
 * du 2026-09-08 : 4 résas annulées parce que le joker n'avait plus de crédits sur la 5e). Les
 * refus sont renvoyés pour être signalés (WhatsApp, Telegram, UI). Si **aucune** ligne n'a pu
 * être réservée, l'erreur d'origine est relancée : l'étape reste en échec, relançable.
 */
export interface RealBookingOptions {
  /** Prête-noms disponibles à la réservation, par priorité (volontaires du sondage, puis règle). */
  substituteIds?: readonly string[];
  /** Plafond « maison » de résas/jour (ADR-016) — un prête-nom qui l'atteint est sauté. */
  maxDailyReservationsPerPlayer?: number;
}

export async function reserveAllForReal(
  deps: GraphDependencies,
  proposedBookings: BookingPlanGroup["plan"]["proposedBookings"],
  jokerBookerId: string | null = null,
  options: RealBookingOptions = {},
): Promise<RealBookingOutcome> {
  const substitutions: JokerSubstitution[] = [];
  const failures: ReservationFailure[] = [];
  let firstError: unknown;
  let reservedCount = 0;
  // Résas du jour par joueur, plan + substitutions effectuées : un prête-nom se consomme
  // exactement comme au plan (ADR-016), il ne doit pas dépasser le plafond à la réservation.
  const dailyCounts = countDailyBookings(proposedBookings);
  const maxDaily = options.maxDailyReservationsPerPlayer ?? Number.POSITIVE_INFINITY;
  const credits: CreditTracker = {
    exhausted: new Map(),
    suspectedJoker: undefined,
    resolveCandidates: nameCandidateResolver(deps, proposedBookings.find((b) => b.groupId)?.groupId),
  };

  for (const b of proposedBookings) {
    const availableSubstitutes = (options.substituteIds ?? []).filter(
      (id) => (dailyCounts.get(id) ?? 0) < maxDaily && !credits.exhausted.has(id),
    );
    const err = await reserveOneForReal(deps, b, jokerBookerId, availableSubstitutes, substitutions, credits);
    if (err === undefined) {
      reservedCount += 1;
      const used = substitutions.at(-1);
      if (used?.sessionId === b.sessionId && used.kind === "substitute") {
        dailyCounts.set(used.jokerBookerId, (dailyCounts.get(used.jokerBookerId) ?? 0) + 1);
      }
      continue;
    }
    firstError ??= err;
    failures.push({
      sessionId: b.sessionId,
      court: b.court,
      slotTime: b.slotTime,
      slotEndTime: b.slotEndTime,
      userId: b.userId,
      partnerId: b.partnerId ?? null,
      ...describeRefusal(err),
    });
  }

  if (reservedCount === 0 && failures.length > 0) throw firstError;
  return { substitutions, failures };
}

function countDailyBookings(bookings: BookingPlanGroup["plan"]["proposedBookings"]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of bookings) {
    for (const id of [b.userId, b.partnerId]) {
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Joueurs dont les crédits TeamR sont épuisés, appris au fil du lot (2026-10-30) : un joueur
 * refusé pour quota (`PLAYER_BOOKING_LIMIT_REACHED`) ne sera pas retenté sur les lignes suivantes —
 * chaque essai est voué à l'échec et reproduirait le même refus. `exhausted` : joueur → son refus
 * d'origine, rendu tel quel pour une ligne écartée d'avance (motif lisible TeamR).
 *
 * Le refus cite le joueur par son nom : `resolveCandidates` donne les noms complets des joueurs
 * d'une ligne pour le rapprocher (`identifyCreditHolder`). Sans correspondance sûre, repli prudent :
 * `suspectedJoker` — le joker est soupçonné au premier refus sans remplacement, et confirmé
 * seulement au refus d'une ligne où il a un autre partenaire (sinon on ne sait pas qui est à sec).
 */
interface CreditTracker {
  exhausted: Map<string, McpToolError>;
  suspectedJoker: { otherId: string; error: McpToolError } | undefined;
  resolveCandidates: (ids: readonly string[]) => Promise<NameCandidate[]>;
}

/** Noms complets (membres du groupe, puis favoris) — best-effort : un échec donne une liste vide. */
function nameCandidateResolver(deps: GraphDependencies, groupId: string | null | undefined) {
  let directory: Promise<NameCandidate[]> | undefined;
  const load = async (): Promise<NameCandidate[]> => {
    const byId = new Map<string, NameCandidate>();
    try {
      if (groupId) {
        const { members } = await listGroupMembers(deps.resaSquash.client, groupId);
        for (const m of members) byId.set(m.user_id, { id: m.user_id, firstName: m.first_name, lastName: m.last_name });
      }
      const { favorites } = await listMyFavorites(deps.resaSquash.client, true);
      for (const f of favorites) if (!byId.has(f.userId)) byId.set(f.userId, { id: f.userId, firstName: f.firstName, lastName: f.lastName });
    } catch {
      // Annuaire indisponible : on retombe sur le repli prudent.
    }
    return [...byId.values()];
  };
  return async (ids: readonly string[]): Promise<NameCandidate[]> => {
    directory ??= load();
    return (await directory).filter((c) => ids.includes(c.id));
  };
}

/**
 * Réserve une ligne (avec cascade prête-noms puis joker, ADR-024/ADR-028). Renvoie `undefined`
 * si la ligne est prise, sinon l'erreur d'origine du refus — jamais levée, pour que l'appelant
 * poursuive le lot. Un joueur déjà connu sans crédit n'est pas retenté : la ligne passe
 * directement à la cascade de remplacement (sans appel `reserve_slot` condamné d'avance).
 */
async function reserveOneForReal(
  deps: GraphDependencies,
  b: BookingPlanGroup["plan"]["proposedBookings"][number],
  jokerBookerId: string | null,
  substituteIds: readonly string[],
  substitutions: JokerSubstitution[],
  credits: CreditTracker,
): Promise<unknown> {
  if (!b.partnerId || !b.startDate) {
    return new Error(`Réservation impossible pour sessionId=${b.sessionId} : partnerId/startDate manquant.`);
  }
  const base = { sessionId: b.sessionId, startDate: b.startDate, groupId: b.groupId };
  // Un joker connu à sec n'est pas proposé en recours : ce serait un appel voué à l'échec.
  const usableJoker = jokerBookerId && !credits.exhausted.has(jokerBookerId) ? jokerBookerId : null;
  const ctx = { base, userId: b.userId, partnerId: b.partnerId, slotTime: b.slotTime, jokerBookerId: usableJoker, substituteIds };
  const lineIds = [b.userId, b.partnerId];
  const knownExhausted = lineIds.filter((id) => credits.exhausted.has(id));
  const knownRefusal = knownExhausted.length > 0 ? credits.exhausted.get(knownExhausted[0]!) : undefined;

  if (knownRefusal) {
    const substituted = await trySubstitution(deps, knownRefusal, { ...ctx, blamedIds: knownExhausted });
    if (!substituted) return knownRefusal;
    substitutions.push(substituted.substitution);
    return undefined;
  }

  try {
    await reserveSlot(deps.resaSquash.client, { ...base, userId: b.userId, partnerId: b.partnerId });
    clearJokerSuspicionOnSuccess(credits, lineIds, jokerBookerId);
    return undefined;
  } catch (err) {
    // Le refus cite le joueur à sec : s'il est identifié, c'est lui qu'on remplace (pas les deux
    // rôles à l'aveugle) et il est écarté des lignes suivantes, qu'un remplacement ait pris ou non.
    const holder = await identifyHolder(credits, err, lineIds);
    if (holder && isQuotaRefusal(err)) credits.exhausted.set(holder, err);
    const substituted = await trySubstitution(deps, err, holder ? { ...ctx, blamedIds: [holder] } : ctx);
    if (substituted) {
      substitutions.push(substituted.substitution);
      if (!holder) noteExhaustedAfterSubstitution(credits, err, substituted.substitution);
      return undefined;
    }
    if (!holder) suspectJokerAfterFailure(credits, err, lineIds, jokerBookerId);
    return err;
  }
}

function isQuotaRefusal(err: unknown): err is McpToolError {
  return err instanceof McpToolError && err.reason === "PLAYER_BOOKING_LIMIT_REACHED";
}

async function identifyHolder(credits: CreditTracker, err: unknown, lineIds: readonly string[]): Promise<string | null> {
  if (!isQuotaRefusal(err) || blamedPlayerIds(err.details).length > 0) return null;
  const name = refusedPlayerName(err);
  return name ? identifyCreditHolder(name, await credits.resolveCandidates(lineIds)) : null;
}

/**
 * Quota refusé puis ligne sauvée par un remplacement : `reserve_slot` est atomique et un seul nom
 * a changé, donc le nom remplacé est celui qui n'avait plus de crédit.
 */
function noteExhaustedAfterSubstitution(credits: CreditTracker, err: unknown, substitution: JokerSubstitution): void {
  if (!isQuotaRefusal(err)) return;
  credits.exhausted.set(substitution.replacedUserId, err);
}

const otherPlayer = (lineIds: readonly string[], jokerBookerId: string): string | undefined =>
  lineIds.find((id) => id !== jokerBookerId);

/**
 * Repli quand le nom du refus n'identifie personne : quota refusé et aucun remplacement n'a pris.
 * Le joker, partenaire de chaque ligne, s'épuise le premier — il est donc soupçonné, mais pas
 * condamné : le fautif peut être l'autre joueur. Il n'est confirmé (écarté des lignes suivantes)
 * qu'au second refus sur une ligne où son partenaire est différent.
 */
function suspectJokerAfterFailure(
  credits: CreditTracker,
  err: unknown,
  lineIds: readonly string[],
  jokerBookerId: string | null,
): void {
  if (!isQuotaRefusal(err) || !jokerBookerId || !lineIds.includes(jokerBookerId)) return;
  const other = otherPlayer(lineIds, jokerBookerId);
  if (!other) return;
  const suspicion = credits.suspectedJoker;
  if (!suspicion) {
    credits.suspectedJoker = { otherId: other, error: err };
  } else if (suspicion.otherId !== other) {
    credits.exhausted.set(jokerBookerId, err);
    credits.suspectedJoker = undefined;
  }
}

/**
 * Ligne réservée avec le joker et un autre partenaire que celui du premier refus : le joker avait
 * donc des crédits, le fautif du premier refus était son partenaire d'alors.
 */
function clearJokerSuspicionOnSuccess(credits: CreditTracker, lineIds: readonly string[], jokerBookerId: string | null): void {
  const suspicion = credits.suspectedJoker;
  if (!suspicion || !jokerBookerId || !lineIds.includes(jokerBookerId)) return;
  if (otherPlayer(lineIds, jokerBookerId) === suspicion.otherId) return;
  credits.exhausted.set(suspicion.otherId, suspicion.error);
  credits.suspectedJoker = undefined;
}

/**
 * Retente une réservation refusée en remplaçant le joueur fautif — même cascade qu'au plan :
 * prête-noms disponibles d'abord, joker en dernier recours (ADR-028). Retourne `null` si la
 * substitution n'est pas applicable (refus d'une autre nature, aucun nom à opposer) ou si
 * aucune tentative n'a abouti — l'appelant conserve alors l'erreur d'origine, plus parlante
 * que celle du dernier essai.
 */
async function trySubstitution(
  deps: GraphDependencies,
  error: unknown,
  ctx: {
    base: { sessionId: string; startDate: string; groupId?: string | null };
    userId: string;
    partnerId: string;
    slotTime: string;
    jokerBookerId: string | null;
    substituteIds: readonly string[];
    /** Fautifs déjà connus (crédits épuisés) : remplace ceux que le refus désigne. */
    blamedIds?: readonly string[];
  },
): Promise<{ params: { userId: string; partnerId: string }; substitution: JokerSubstitution } | null> {
  if (!(error instanceof McpToolError) || !isSubstitutableReason(error.reason)) return null;

  const candidates = bookingSubstitutionCandidates({
    userId: ctx.userId,
    partnerId: ctx.partnerId,
    jokerBookerId: ctx.jokerBookerId,
    blamedIds: ctx.blamedIds ? [...ctx.blamedIds] : blamedPlayerIds(error.details),
    substituteIds: ctx.substituteIds,
  });

  for (const candidate of candidates) {
    try {
      await reserveSlot(deps.resaSquash.client, {
        ...ctx.base,
        userId: candidate.userId,
        partnerId: candidate.partnerId,
      });
    } catch {
      // Mauvais joueur substitué (quota non désigné par resa-squash) : on tente l'autre nom.
      continue;
    }
    return {
      params: { userId: candidate.userId, partnerId: candidate.partnerId },
      substitution: {
        sessionId: ctx.base.sessionId,
        slotTime: ctx.slotTime,
        replacedUserId: candidate.replaced,
        jokerBookerId: candidate.by,
        kind: candidate.kind,
        reason: error.reason as string,
      },
    };
  }
  return null;
}

/**
 * Récupère le mapping userId resa-squash → pseudo (`playerMessageName`) pour affichage dans la synthèse /
 * le rappel J+1 — best-effort, ne doit jamais faire échouer l'appelant si resa-squash est
 * indisponible. Exporté pour réutilisation par le scheduler (triggerNextDayReminder).
 */
export async function fetchMemberNames(
  resaSquash: McpConnection,
  resaSquashGroupId: string,
): Promise<Record<string, string>> {
  const { names } = await fetchGroupMemberDirectory(resaSquash, resaSquashGroupId);
  return names;
}

/**
 * Complète un annuaire `userId → nom` avec les **favoris** du compte resa-squash, pour les
 * joueurs cités dans un plan sans être membres du groupe — typiquement le **joker** (ADR-024),
 * choisi parmi les favoris et rarement membre du groupe. Sans ça ses lignes s'affichaient avec
 * un userId brut dans le plan Telegram et la synthèse (constaté 2026-09-06), contrairement à la
 * règle "Noms vs identifiants" (§7 des règles fonctionnelles).
 *
 * `includeUnregistered` : un joueur non réinscrit peut malgré tout figurer dans un plan (c'est
 * précisément ce qui déclenche le joker) — il faut donc pouvoir afficher son nom.
 * Best-effort : aucun appel si rien ne manque, et un échec favoris laisse l'annuaire inchangé.
 */
export async function completeNamesFromFavorites(
  resaSquash: McpConnection,
  names: Record<string, string>,
  citedUserIds: Array<string | null | undefined>,
): Promise<Record<string, string>> {
  const missing = new Set(citedUserIds.filter((id): id is string => Boolean(id) && !names[id!]));
  if (missing.size === 0) return names;

  const { favorites } = await listMyFavorites(resaSquash.client, true).catch(() => ({
    favorites: [] as Favorite[],
  }));
  const completed = { ...names };
  for (const fav of favorites) {
    if (!missing.has(fav.userId)) continue;
    const label = playerMessageName(fav);
    if (label) completed[fav.userId] = label;
  }
  return completed;
}

/**
 * Noms **et** statut de réinscription des membres du groupe, en un seul appel MCP.
 * `unregisteredPlayerIds` ne contient que les membres explicitement marqués non réinscrits
 * (`isRegistered === false`) : un statut absent — vieux serveur resa-squash, licencié inconnu —
 * ne doit jamais faire croire qu'un joueur ne peut pas réserver. Voir ADR-024.
 */
export async function fetchGroupMemberDirectory(
  resaSquash: McpConnection,
  resaSquashGroupId: string,
): Promise<{ names: Record<string, string>; unregisteredPlayerIds: Set<string> }> {
  const { members } = await listGroupMembers(resaSquash.client, resaSquashGroupId);
  const names: Record<string, string> = {};
  const unregisteredPlayerIds = new Set<string>();
  for (const m of members) {
    const name = playerMessageName({ nickname: m.nickname, firstName: m.first_name, lastName: m.last_name });
    if (name) names[m.user_id] = name;
    if (m.isRegistered === false) unregisteredPlayerIds.add(m.user_id);
  }
  return { names, unregisteredPlayerIds };
}

/**
 * Synthèse texte (votes reçus vs réservations effectuées, avec raison si rien n'a été réservé)
 * — envoyée uniquement au groupe de test (reservationNotifyWhatsappGroupJid configuré), en plus
 * du message d'annonce habituel. Aucune donnée recalculée : réutilise confirmedPlayerIdsByTime,
 * volunteerSubstituteIds et bookingPlanGroups déjà produits par collectVotes.ts/bookSlots.ts.
 * `memberNames` (userId → pseudo, cf. `playerMessageName`) est facultatif — un userId absent du mapping est affiché
 * tel quel.
 */
export function buildVoteBookingSynthesis(
  bookingRule: BookingRule,
  targetDate: string,
  confirmedPlayerIdsByTime: Record<string, string[]>,
  bookingPlanGroups: BookingPlanGroup[],
  memberNames: Record<string, string> = {},
  volunteerSubstituteIds: string[] = [],
  reservationFailures: ReservationFailure[] = [],
  unresolvedVoters: UnresolvedVoter[] = [],
): string {
  const displayName = (userId: string): string => memberNames[userId] ?? userId;
  // Les notes du moteur de plan citent les joueurs par id : on les résout ici (cf. bookSlots.ts).
  const humanize = (text: string): string => resolvePlayerIdsInText(text, memberNames);
  const failureBySession = new Map(reservationFailures.map((f) => [f.sessionId, f]));

  const votedTimes = bookingRule.candidateStartTimes.filter(
    (time) => (confirmedPlayerIdsByTime[time] ?? []).length > 0,
  );
  const votesBlock = votedTimes
    .map((time) => `• ${time} : ${(confirmedPlayerIdsByTime[time] ?? []).map(displayName).join(", ")}`)
    .join("\n");

  // Prête-noms volontaires (ADR-017) : par job, pas par heure candidate — jamais mélangés aux votes confirmés.
  // Volontaires sans compte resa-squash : nom WhatsApp nettoyé (jamais de téléphone, c'est un groupe WhatsApp)
  // + ⚠️ (message de debug, groupe test uniquement — spec 2026-10-09 §3.4).
  const unresolvedVolunteers = unresolvedVoters
    .filter((v) => v.option === SUBSTITUTE_VOLUNTEER_POLL_OPTION)
    .map((v) => `${publicVoterName(v.name)} ⚠️ non identifié`);
  const volunteersBlock = [...volunteerSubstituteIds.map(displayName), ...unresolvedVolunteers].join(", ");

  const groupsBlock = bookingPlanGroups
    .map((g) => {
      if (g.plan.proposedBookings.length === 0) {
        const reason = humanize(g.plan.warnings.join(" ")) || "aucun détail disponible";
        return `• ${g.startTime} : rien réservé — ${reason}`;
      }
      const bookedList = g.plan.proposedBookings
        .map(
          (b) =>
            `${b.slotTime}-${b.slotEndTime} (court ${b.court}) ${displayName(b.userId)}${b.partnerId ? ` et ${displayName(b.partnerId)}` : ""}${
              failureBySession.has(b.sessionId) ? ` [non réservé — ${failureBySession.get(b.sessionId)!.message}]` : ""
            }`,
        )
        .join(", ");
      const warningsSuffix = g.plan.warnings.length > 0 ? ` — ${humanize(g.plan.warnings.join(" "))}` : "";
      return `• ${g.startTime} : ${bookedList}${warningsSuffix}`;
    })
    .join("\n");

  return (
    `📊 Synthèse « ${bookingRule.name ?? bookingRule.id} » — ${targetDate}\n\n` +
    `Votes reçus :\n${votesBlock || "(aucun)"}\n\n` +
    `Prête-noms volontaires :\n${volunteersBlock || "(aucun)"}\n\n` +
    `Réservations :\n${groupsBlock || "(aucune)"}`
  );
}

/** "2026-09-12" -> "samedi" (fuseau Europe/Paris, comme pollQuestion.ts). */
function formatWeekday(targetDate: string): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", weekday: "long" }).format(
    new Date(`${targetDate}T00:00:00Z`),
  );
}

/** Titre WhatsApp de l'annonce, accordé au nombre de créneaux fusionnés (spec 2026-10-09 §4.3). */
export function buildAnnounceTitle(realBooking: boolean, mergedSlotCount: number): string {
  const plural = mergedSlotCount >= 2;
  if (realBooking) return plural ? "🏸 Réservations confirmées" : "🏸 Réservation confirmée";
  return plural ? "🏸 Réservations" : "🏸 Réservation";
}

/** Message WhatsApp quand aucune ligne n'a pu être réservée — générique, jamais le texte brut. */
export function buildTotalFailureMessage(targetDate: string): string {
  return `⚠️ Échec de la réservation du ${targetDate} : aucun court n'a été réservé. Contactez l'organisateur.`;
}

export type BookingMessageVariant = "confirmation" | "start-reminder";

/**
 * Confirmation WhatsApp des réservations (étape 5) ou rappel avant le match (`variant: "start-reminder"`, ADR-036) —
 * date, courts fusionnés et joueurs ayant répondu oui au sondage. Pas de nom de règle ni de prête-noms :
 * ce détail reste sur Telegram / la synthèse (ADR-016).
 */
export function buildBookingConfirmationMessage(
  bookingRule: BookingRule,
  targetDate: string,
  bookingPlanGroups: BookingPlanGroup[],
  confirmedPlayerIdsByTime: Record<string, string[]>,
  memberNames: Record<string, string>,
  realBooking: boolean,
  reservationFailures: ReservationFailure[] = [],
  variant: BookingMessageVariant = "confirmation",
  inscritsByTime?: Record<string, string[]>,
): string {
  const displayName = (userId: string): string => memberNames[userId] ?? userId;

  const slots = reservedBookings(bookingPlanGroups, reservationFailures).map((b) => ({
    court: b.court,
    beginTime: b.slotTime,
    endTime: b.slotEndTime,
  }));
  const merged = mergeContiguousSlotsByCourt(slots);

  // Avec un roster vivant : les inscrits courants (noms déjà rendus) remplacent « Oui au sondage » figé au plan.
  const blockTitle = inscritsByTime ? "Inscrits" : "Oui au sondage";
  const namesByTime =
    inscritsByTime ??
    Object.fromEntries(Object.entries(confirmedPlayerIdsByTime).map(([time, ids]) => [time, ids.map(displayName)]));
  const votesBlock = bookingRule.candidateStartTimes
    .filter((time) => (namesByTime[time] ?? []).length > 0)
    .map((time) => `\u2022 ${time} : ${(namesByTime[time] ?? []).join(", ")}`)
    .join("\n");
  const votesSection = votesBlock ? `\n\n${blockTitle} :\n${votesBlock}` : "";

  const weekday = formatWeekday(targetDate);
  const header =
    variant === "start-reminder"
      ? realBooking
        ? `⏰ Rappel — Squash aujourd'hui (${weekday})`
        : `⏰ Rappel (dry-run — aucun court réservé) — ${weekday}`
      : // Dry-run : la confirmation ne doit pas laisser croire que les courts sont vraiment pris.
        `✅ Confirmation — ${realBooking ? `Réservation pour ${weekday}` : `Réservation (dry-run) pour ${weekday}`}`;

  return `${header}\n\n📅 ${targetDate}\n\n${formatMergedCourtSlots(merged)}${votesSection}`;
}

/** Annonce des courts d'un job legacy (sans roster vivant) : envoi WhatsApp puis épinglage best-effort. */
async function sendLegacyAnnounce(
  deps: GraphDependencies,
  bookingRule: BookingRule,
  jobRunId: string,
  notifyJid: string,
  message: string,
): Promise<string> {
  const { msgId: announceMsgId } = await sendMessage(deps.huddleBot.client, notifyJid, message);
  if (bookingRule.pinMessagesEnabled && announceMsgId) {
    await pinBestEffort(deps, bookingRule.name ?? bookingRule.id, notifyJid, announceMsgId, "de l'annonce");
    await setJobRunAnnounceInfo(deps.db, jobRunId, { msgId: announceMsgId, jid: notifyJid });
  }
  return message;
}

export function createAnnounceNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const {
      bookingRule,
      jobRunId,
      targetDate,
      goConfirmed,
      bookingPlanGroups,
      dryRun,
      confirmedPlayerIdsByTime,
      volunteerSubstituteIds,
      unresolvedVoters,
    } = state;
    const groups = bookingPlanGroups ?? [];
    // Les réservations hors fenêtre acceptée (outOfWindowSessionIds, cf. ADR-014) ne sont
    // jamais réservées ni annoncées — seulement affichées à l'étape 3.
    const allProposedBookings = groups.flatMap((g) =>
      g.plan.proposedBookings.filter((b) => !g.outOfWindowSessionIds.includes(b.sessionId)),
    );

    if (!goConfirmed || allProposedBookings.length === 0) {
      await emitEvent(deps.db, {
        bookingRuleId: bookingRule.id,
        jobRunId,
        type: "booking",
        status: "success",
        targetDate,
        detail: { step: "cancelled", reason: "no-go-confirmation" },
      });
      await sendTelegramMessage(
        deps.telegram,
        `[${bookingRule.name ?? bookingRule.id}] Pas de "go" reçu — aucune annonce envoyée pour le ${targetDate}.`,
      );
      return {};
    }

    // dryRun !== false : seule la reprise "go-real" (UI dry-run décoché, ou
    // Telegram go sur job auto) déclenche reserve_slot — voir waitForGoConfirmation.
    const realBooking = dryRun === false;
    const notifyJid = await resolveAnnounceNotifyJid(deps, bookingRule);
    // Roster vivant (spec 2026-10-24-roster-desistements §4.5, CA-3) : un job planifié avec un
    // snapshot de votes publie le roster définitif à la place de l'annonce. Sinon : legacy.
    const job = jobRunId ? await getJobRunById(deps.db, bookingRule.id, jobRunId) : undefined;
    const rosterSnapshot = job?.rosterPlanSnapshot ?? null;

    const outcome = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "booking", targetDate },
      async () => {
        let jokerSubstitutions: JokerSubstitution[] = [];
        let reservationFailures: ReservationFailure[] = [];
        if (realBooking) {
          try {
            ({ substitutions: jokerSubstitutions, failures: reservationFailures } = await reserveAllForReal(
              deps,
              allProposedBookings,
              await resolveLiveJokerBookerId(deps, bookingRule),
              {
                substituteIds: bookingSubstituteQueue(volunteerSubstituteIds ?? [], bookingRule.substituteBookers),
                maxDailyReservationsPerPlayer: bookingRule.maxDailyReservationsPerPlayer,
              },
            ));
          } catch (err) {
            // Silence WhatsApp total sinon en cas d'échec réel (bug réel 2026-08-26, ex.
            // reserve_slot rejeté par resa-squash avec "noCredits") : reserveAllForReal lève
            // avant tout envoi WhatsApp, et le rollback (best-effort) annule les résas déjà
            // faites du même lot — le groupe ne voyait ni confirmation ni erreur. Message
            // volontairement générique (pas le texte brut de l'erreur, réservé à Telegram
            // via withEventLogging/le scheduler) — un joueur n'a pas besoin du détail technique.
            await sendMessage(
              deps.huddleBot.client,
              notifyJid,
              buildTotalFailureMessage(targetDate),
            ).catch(() => {});
            throw err;
          }

          if (jokerSubstitutions.length > 0) {
            // Canal organisateur (Telegram), pas le groupe WhatsApp : comme pour les prête-noms
            // (ADR-016), le nom porté par TeamR n'intéresse pas les joueurs — mais l'organisateur
            // doit savoir que la ligne n'est pas au nom du joueur attendu.
            const memberNames = await fetchMemberNames(deps.resaSquash, bookingRule.resaSquashGroupId).catch(
              () => ({}) as Record<string, string>,
            );
            const names = await completeNamesFromFavorites(
              deps.resaSquash,
              memberNames,
              jokerSubstitutions.flatMap((sub) => [sub.replacedUserId, sub.jokerBookerId]),
            );
            const label = (userId: string): string => names[userId] ?? userId;
            await sendTelegramMessage(
              deps.telegram,
              `[${bookingRule.name ?? bookingRule.id}] Joker utilisé pour le ${targetDate} :\n` +
                jokerSubstitutions.map((sub) => `  • ${formatSubstitution(sub, label)}`).join("\n"),
            ).catch(() => {});
          }
        }

        const reserved = reservedBookings(groups, reservationFailures);
        const slots = reserved.map((b) => ({
          court: b.court,
          beginTime: b.slotTime,
          endTime: b.slotEndTime,
        }));
        const merged = mergeContiguousSlotsByCourt(slots);
        // Pas "capacité des courts dépassée" : la cause réelle (quota resa-squash,
        // effectif insuffisant, etc.) n'est pas toujours un vrai manque de courts —
        // voir le détail du plan à l'étape 3 (UI admin) pour le motif exact.
        const unplacedPlayerCount = countUnbookedConfirmedPlayers(groups, confirmedPlayerIdsByTime ?? {}, reservationFailures);
        // Lignes refusées par TeamR/resa-squash (ADR-027) : motif lisible seulement, pas le JSON — et
        // seulement pour l'organisateur ; le groupe des joueurs n'a que la raison du manque (2026-10-30).
        const { failuresNote, capacityNote } = buildAnnounceNotes({
          toPlayersGroup: notifyJid === bookingRule.whatsappGroupJid,
          failures: reservationFailures,
          unresolvedVoters: unresolvedVoters ?? [],
          unplacedPlayerCount,
          failuresBlock: formatFailuresBlock(reservationFailures, (f) => f.message),
        });
        const title = buildAnnounceTitle(realBooking, merged.length);
        const courtsBlock = formatMergedCourtSlots(merged);
        // Le roster définitif porte son propre épinglage (publishRoster) : ni sendMessage ni setJobRunAnnounceInfo.
        // Son échec d'envoi ne fait pas échouer l'étape (B1-8) : Telegram, le tick republie, QR et fin normales.
        // `rosterSent` (B2-5) : renseigné seulement en mode roster ; false = le tick republiera.
        const { message, rosterSent } =
          job && rosterSnapshot
            ? await publishFinalRoster({
                deps,
                job,
                snapshot: rosterSnapshot,
                rule: bookingRule,
                ruleLabel: bookingRule.name ?? bookingRule.id,
                notifyJid,
                groups,
                failures: reservationFailures,
                realBooking,
                title,
                courtsBlock,
                failuresNote,
                capacityNote,
              }).then(({ text, sent }) => ({ message: text, rosterSent: sent as boolean | undefined }))
            : {
                message: await sendLegacyAnnounce(
                  deps,
                  bookingRule,
                  jobRunId,
                  notifyJid,
                  `${title}\n\n📅 ${targetDate}\n\n${courtsBlock}${failuresNote}${capacityNote}`,
                ),
                rosterSent: undefined,
              };

        // Détail « Non réservé » pour l'organisateur : le groupe des joueurs ne l'a plus (2026-10-30),
        // il part sur le groupe de test — sauf s'il vient déjà d'y être annoncé. Best-effort.
        if (reservationFailures.length > 0 && deps.testGroupJid && deps.testGroupJid !== notifyJid) {
          await sendMessage(
            deps.huddleBot.client,
            deps.testGroupJid,
            `[${bookingRule.name ?? bookingRule.id}] ${targetDate}${formatFailuresBlock(reservationFailures, (f) => f.message)}`,
          ).catch((err) => console.error(`[${bookingRule.id}] Échec envoi détail « Non réservé » au groupe test (non bloquant) :`, err));
        }

        // QR d'accès au club, un par court — seulement après une réservation réelle (en
        // dry-run il n'y a rien à ouvrir). Best-effort : l'annonce est déjà partie, un QR
        // manquant ne doit pas transformer un succès en échec de nœud.
        if (realBooking) {
          await sendBookingQrCodes(deps, notifyJid, reserved);
        }

        if (notifyJid !== bookingRule.whatsappGroupJid) {
          // Synthèse cosmétique/secondaire — ne doit jamais faire échouer le nœud alors que
          // la réservation réelle et l'annonce principale ont déjà été envoyées.
          try {
            const memberNames = await completeNamesFromFavorites(
              deps.resaSquash,
              await fetchMemberNames(deps.resaSquash, bookingRule.resaSquashGroupId).catch(() => ({})),
              groups.flatMap((g) => g.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId])),
            );
            const synthesis = buildVoteBookingSynthesis(
              bookingRule,
              targetDate,
              confirmedPlayerIdsByTime,
              groups,
              memberNames,
              volunteerSubstituteIds,
              reservationFailures,
              unresolvedVoters ?? [],
            );
            await sendMessage(deps.huddleBot.client, notifyJid, synthesis);
            await emitEvent(deps.db, {
              bookingRuleId: bookingRule.id,
              jobRunId,
              type: "booking",
              status: "success",
              targetDate,
              detail: { step: "synthesis-sent", notifyJid },
            });
          } catch (err) {
            await emitEvent(deps.db, {
              bookingRuleId: bookingRule.id,
              jobRunId,
              type: "booking",
              status: "error",
              targetDate,
              detail: { step: "synthesis-failed", notifyJid, error: err instanceof Error ? err.message : String(err) },
            });
            console.error(`[${bookingRule.id}] Échec envoi synthèse vote/réservation (non bloquant) :`, err);
          }
        }

        return {
          result: { message, reservationFailures, rosterSent },
          detail: { step: "announced", realBooking, merged, message, unplacedPlayerCount, notifyJid, reservationFailures, rosterSent },
        };
      },
    );

    // Canal organisateur : le code de refus et le texte brut, utiles pour agir (ADR-016).
    const telegramFailures = formatFailuresBlock(outcome.reservationFailures, (f) => `${f.reason ?? "?"} — ${f.rawError}`);
    const rosterNotSent = outcome.rosterSent === false ? " (roster non envoyé, nouvel essai par le tick)" : "";
    await sendTelegramMessage(
      deps.telegram,
      `[${bookingRule.name ?? bookingRule.id}] Annonce envoyée pour le ${targetDate}${realBooking ? " (RÉSERVATION RÉELLE)" : ""} (WhatsApp ${notifyJid})${rosterNotSent}.${telegramFailures}`,
    );

    return { announceMessage: outcome.message, reservationFailures: outcome.reservationFailures };
  };
}
