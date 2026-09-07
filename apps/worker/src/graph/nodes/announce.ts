import type { BookingRule } from "@squash-assistant/db/schema";
import { getBookingRuleById } from "../../bookingRules.js";
import {
  reserveSlot,
  cancelReservation,
  listGroupMembers,
  listMyFavorites,
  type Favorite,
} from "../../mcp/resaSquash.js";
import { sendMessage } from "../../mcp/huddleBot.js";
import { McpToolError, type McpConnection } from "../../mcp/client.js";
import {
  blamedPlayerIds,
  formatSubstitution,
  isSubstitutableReason,
  substitutionCandidates,
  type JokerSubstitution,
} from "../../planning/jokerSubstitution.js";
import { countPlayersInSessions, computeShortfall } from "../capacityPlanning.js";
import { formatMergedCourtSlots, mergeContiguousSlotsByCourt } from "../slotMerge.js";
import { sendBookingQrCodes } from "../bookingQr.js";
import { resolvePlayerIdsInText } from "../formatWarning.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { emitEvent, withEventLogging } from "../emitEvent.js";
import type { GraphDependencies } from "../dependencies.js";
import type { BookingPlanGroup, PipelineStateType } from "../state.js";

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
 * En cas d'échec non rattrapable, tente d'annuler (best-effort, ne masque jamais l'erreur
 * d'origine) les réservations déjà passées avant de relancer — évite de laisser une
 * réservation réelle partielle et incohérente en cas de plan multi-créneaux/multi-heures.
 */
export async function reserveAllForReal(
  deps: GraphDependencies,
  proposedBookings: BookingPlanGroup["plan"]["proposedBookings"],
  jokerBookerId: string | null = null,
): Promise<JokerSubstitution[]> {
  const reserved: Array<{ sessionId: string; userId: string; partnerId: string }> = [];
  const substitutions: JokerSubstitution[] = [];

  try {
    for (const b of proposedBookings) {
      if (!b.partnerId || !b.startDate) {
        throw new Error(`Réservation impossible pour sessionId=${b.sessionId} : partnerId/startDate manquant.`);
      }
      const base = {
        sessionId: b.sessionId,
        startDate: b.startDate,
        groupId: b.groupId,
      };

      try {
        await reserveSlot(deps.resaSquash.client, { ...base, userId: b.userId, partnerId: b.partnerId });
        reserved.push({ sessionId: b.sessionId, userId: b.userId, partnerId: b.partnerId });
        continue;
      } catch (err) {
        const substituted = await tryJokerSubstitution(deps, err, {
          base,
          userId: b.userId,
          partnerId: b.partnerId,
          slotTime: b.slotTime,
          jokerBookerId,
        });
        if (!substituted) throw err;
        reserved.push({
          sessionId: b.sessionId,
          userId: substituted.params.userId,
          partnerId: substituted.params.partnerId,
        });
        substitutions.push(substituted.substitution);
      }
    }
  } catch (err) {
    for (const r of reserved.reverse()) {
      await cancelReservation(deps.resaSquash.client, r).catch(() => {});
    }
    throw err;
  }

  return substitutions;
}

/**
 * Retente une réservation refusée en substituant le joker au joueur fautif.
 * Retourne `null` si la substitution n'est pas applicable (refus d'une autre nature, pas de
 * joker configuré, ou aucun titulaire valide à opposer) ou si aucune tentative n'a abouti —
 * l'appelant relance alors l'erreur d'origine, plus parlante que celle du dernier essai.
 */
async function tryJokerSubstitution(
  deps: GraphDependencies,
  error: unknown,
  ctx: {
    base: { sessionId: string; startDate: string; groupId?: string | null };
    userId: string;
    partnerId: string;
    slotTime: string;
    jokerBookerId: string | null;
  },
): Promise<{ params: { userId: string; partnerId: string }; substitution: JokerSubstitution } | null> {
  if (!(error instanceof McpToolError) || !isSubstitutableReason(error.reason)) return null;
  if (!ctx.jokerBookerId) return null;

  const candidates = substitutionCandidates({
    userId: ctx.userId,
    partnerId: ctx.partnerId,
    jokerBookerId: ctx.jokerBookerId,
    blamedIds: blamedPlayerIds(error.details),
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
        jokerBookerId: ctx.jokerBookerId,
        reason: error.reason as string,
      },
    };
  }
  return null;
}

/**
 * Récupère le mapping userId resa-squash → "Prénom Nom" pour affichage dans la synthèse /
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
    const label = `${fav.firstName ?? ""} ${fav.lastName ?? ""}`.trim();
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
    names[m.user_id] = `${m.first_name} ${m.last_name}`.trim();
    if (m.isRegistered === false) unregisteredPlayerIds.add(m.user_id);
  }
  return { names, unregisteredPlayerIds };
}

/**
 * Synthèse texte (votes reçus vs réservations effectuées, avec raison si rien n'a été réservé)
 * — envoyée uniquement au groupe de test (reservationNotifyWhatsappGroupJid configuré), en plus
 * du message d'annonce habituel. Aucune donnée recalculée : réutilise confirmedPlayerIdsByTime,
 * volunteerSubstituteIds et bookingPlanGroups déjà produits par collectVotes.ts/bookSlots.ts.
 * `memberNames` (userId → "Prénom Nom") est facultatif — un userId absent du mapping est affiché
 * tel quel.
 */
export function buildVoteBookingSynthesis(
  bookingRule: BookingRule,
  targetDate: string,
  confirmedPlayerIdsByTime: Record<string, string[]>,
  bookingPlanGroups: BookingPlanGroup[],
  memberNames: Record<string, string> = {},
  volunteerSubstituteIds: string[] = [],
): string {
  const displayName = (userId: string): string => memberNames[userId] ?? userId;
  // Les notes du moteur de plan citent les joueurs par id : on les résout ici (cf. bookSlots.ts).
  const humanize = (text: string): string => resolvePlayerIdsInText(text, memberNames);

  const votedTimes = bookingRule.candidateStartTimes.filter(
    (time) => (confirmedPlayerIdsByTime[time] ?? []).length > 0,
  );
  const votesBlock = votedTimes
    .map((time) => `• ${time} : ${(confirmedPlayerIdsByTime[time] ?? []).map(displayName).join(", ")}`)
    .join("\n");

  // Prête-noms volontaires (ADR-017) : par job, pas par heure candidate — jamais mélangés aux votes confirmés.
  const volunteersBlock = volunteerSubstituteIds.map(displayName).join(", ");

  const groupsBlock = bookingPlanGroups
    .map((g) => {
      if (g.plan.proposedBookings.length === 0) {
        const reason = humanize(g.plan.warnings.join(" ")) || "aucun détail disponible";
        return `• ${g.startTime} : rien réservé — ${reason}`;
      }
      const bookedList = g.plan.proposedBookings
        .map(
          (b) =>
            `${b.slotTime}-${b.slotEndTime} (court ${b.court}) ${displayName(b.userId)}${b.partnerId ? ` et ${displayName(b.partnerId)}` : ""}`,
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

/**
 * Message du rappel WhatsApp J+1 (`BookingRule.nextDayReminderEnabled`) — recalculé à l'envoi,
 * pas un simple renvoi de `announceMessage` : mêmes courts fusionnés que l'annonce d'origine,
 * plus les votes reçus par heure (noms résolus via `memberNames`).
 *
 * Message volontairement minimal (demande 2026-09-06) : pas de nom de règle, pas de prête-noms
 * utilisés, pas de mention de l'origine automatique ni de clôture du sondage — un joueur n'a
 * besoin que du jour, des courts réservés et de qui vient à quelle heure. Le détail
 * (prête-noms, joker, avertissements de plan) reste réservé au canal organisateur
 * (Telegram / synthèse, cf. ADR-016).
 */
export function buildNextDayReminderMessage(
  bookingRule: BookingRule,
  targetDate: string,
  bookingPlanGroups: BookingPlanGroup[],
  confirmedPlayerIdsByTime: Record<string, string[]>,
  memberNames: Record<string, string>,
  realBooking: boolean,
): string {
  const displayName = (userId: string): string => memberNames[userId] ?? userId;

  const slots = bookingPlanGroups.flatMap((g) =>
    g.plan.proposedBookings
      .filter((b) => !g.outOfWindowSessionIds.includes(b.sessionId))
      .map((b) => ({ court: b.court, beginTime: b.slotTime, endTime: b.slotEndTime })),
  );
  const merged = mergeContiguousSlotsByCourt(slots);

  const votedTimes = bookingRule.candidateStartTimes.filter(
    (time) => (confirmedPlayerIdsByTime[time] ?? []).length > 0,
  );
  const votesBlock = votedTimes
    .map((time) => `\u2022 ${time} : ${(confirmedPlayerIdsByTime[time] ?? []).map(displayName).join(", ")}`)
    .join("\n");
  const votesSection = votesBlock ? `\n\n${votesBlock}` : "";

  // Dry-run : le rappel ne doit pas laisser croire que les courts sont vraiment pris.
  const title = realBooking
    ? `Réservation pour ${formatWeekday(targetDate)}`
    : `Réservation (dry-run) pour ${formatWeekday(targetDate)}`;

  return `🔔 Rappel — ${title}\n\n📅 ${targetDate}\n\n${formatMergedCourtSlots(merged)}${votesSection}`;
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
    } = state;
    const groups = bookingPlanGroups ?? [];
    // Les réservations hors fenêtre acceptée (outOfWindowSessionIds, cf. ADR-014) ne sont
    // jamais réservées ni annoncées — seulement affichées à l'étape 3.
    const allProposedBookings = groups.flatMap((g) =>
      g.plan.proposedBookings.filter((b) => !g.outOfWindowSessionIds.includes(b.sessionId)),
    );
    const unplacedPlayerCount = groups.reduce(
      (n, g) => n + computeShortfall(g.plan) + countPlayersInSessions(g.plan, g.outOfWindowSessionIds),
      0,
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

    const message = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "booking", targetDate },
      async () => {
        let jokerSubstitutions: JokerSubstitution[] = [];
        if (realBooking) {
          try {
            jokerSubstitutions = await reserveAllForReal(
              deps,
              allProposedBookings,
              await resolveLiveJokerBookerId(deps, bookingRule),
            );
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
              `⚠️ Réservation(s) « ${bookingRule.name ?? bookingRule.id} » du ${targetDate} : échec de la réservation automatique, aucun court n'a été réservé. Contactez l'organisateur.`,
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

        const slots = allProposedBookings.map((b) => ({
          court: b.court,
          beginTime: b.slotTime,
          endTime: b.slotEndTime,
        }));
        const merged = mergeContiguousSlotsByCourt(slots);
        const prefix = realBooking ? "🏸 Réservation(s) confirmée(s)" : "🏸 Réservation(s)";
        // Pas "capacité des courts dépassée" : la cause réelle (quota resa-squash,
        // effectif insuffisant, etc.) n'est pas toujours un vrai manque de courts —
        // voir le détail du plan à l'étape 3 (UI admin) pour le motif exact.
        const capacityNote =
          unplacedPlayerCount > 0 ? `\n\n⚠️ ${unplacedPlayerCount} joueur(s) n'ont pas pu être réservé(s) cette semaine.` : "";
        // Distingue cette annonce de la notification native resa-squash/TeamR (envoyée aussi
        // aux réservations manuelles) : seul indice visible dans le groupe WhatsApp de l'origine
        // automatique d'une réservation.
        const originNote = realBooking ? "\n\n🤖 Réservation effectuée automatiquement par squash-assistant." : "";
        const message = `${prefix} « ${bookingRule.name ?? bookingRule.id} »\n\n📅 ${targetDate}\n\n${formatMergedCourtSlots(merged)}${capacityNote}${originNote}`;

        await sendMessage(deps.huddleBot.client, notifyJid, message);

        // QR d'accès au club, un par court — seulement après une réservation réelle (en
        // dry-run il n'y a rien à ouvrir). Best-effort : l'annonce est déjà partie, un QR
        // manquant ne doit pas transformer un succès en échec de nœud.
        if (realBooking) {
          await sendBookingQrCodes(deps, notifyJid, allProposedBookings);
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
          result: message,
          detail: { step: "announced", realBooking, merged, message, unplacedPlayerCount, notifyJid },
        };
      },
    );

    await sendTelegramMessage(
      deps.telegram,
      `[${bookingRule.name ?? bookingRule.id}] Annonce envoyée pour le ${targetDate}${realBooking ? " (RÉSERVATION RÉELLE)" : ""} (WhatsApp ${notifyJid}).`,
    );

    return { announceMessage: message };
  };
}
