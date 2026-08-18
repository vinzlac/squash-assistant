import type { BookingRule } from "@squash-assistant/db/schema";
import { getBookingRuleById } from "../../bookingRules.js";
import { reserveSlot, cancelReservation, listGroupMembers } from "../../mcp/resaSquash.js";
import { sendMessage } from "../../mcp/huddleBot.js";
import type { McpConnection } from "../../mcp/client.js";
import { countPlayersInSessions, computeShortfall } from "../capacityPlanning.js";
import { formatMergedCourtSlots, mergeContiguousSlotsByCourt } from "../slotMerge.js";
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
 * En cas d'échec en cours de route, tente d'annuler (best-effort, ne masque
 * jamais l'erreur d'origine) les réservations déjà passées avant de relancer
 * — évite de laisser une réservation réelle partielle et incohérente en cas
 * de plan multi-créneaux/multi-heures.
 */
async function reserveAllForReal(
  deps: GraphDependencies,
  proposedBookings: BookingPlanGroup["plan"]["proposedBookings"],
): Promise<void> {
  const reserved: Array<{ sessionId: string; userId: string; partnerId: string }> = [];
  try {
    for (const b of proposedBookings) {
      if (!b.partnerId || !b.startDate) {
        throw new Error(`Réservation impossible pour sessionId=${b.sessionId} : partnerId/startDate manquant.`);
      }
      await reserveSlot(deps.resaSquash.client, {
        sessionId: b.sessionId,
        userId: b.userId,
        partnerId: b.partnerId,
        startDate: b.startDate,
        groupId: b.groupId,
      });
      reserved.push({ sessionId: b.sessionId, userId: b.userId, partnerId: b.partnerId });
    }
  } catch (err) {
    for (const r of reserved.reverse()) {
      await cancelReservation(deps.resaSquash.client, r).catch(() => {});
    }
    throw err;
  }
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
  const { members } = await listGroupMembers(resaSquash.client, resaSquashGroupId);
  const names: Record<string, string> = {};
  for (const m of members) {
    names[m.user_id] = `${m.first_name} ${m.last_name}`.trim();
  }
  return names;
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
        const reason = g.plan.warnings.join(" ") || "aucun détail disponible";
        return `• ${g.startTime} : rien réservé — ${reason}`;
      }
      const bookedList = g.plan.proposedBookings
        .map(
          (b) =>
            `${b.slotTime}-${b.slotEndTime} (court ${b.court}) ${displayName(b.userId)}${b.partnerId ? ` et ${displayName(b.partnerId)}` : ""}`,
        )
        .join(", ");
      const warningsSuffix = g.plan.warnings.length > 0 ? ` — ${g.plan.warnings.join(" ")}` : "";
      return `• ${g.startTime} : ${bookedList}${warningsSuffix}`;
    })
    .join("\n");

  return (
    `📊 Synthèse « ${bookingRule.id} » — ${targetDate}\n\n` +
    `Votes reçus :\n${votesBlock || "(aucun)"}\n\n` +
    `Prête-noms volontaires :\n${volunteersBlock || "(aucun)"}\n\n` +
    `Réservations :\n${groupsBlock || "(aucune)"}`
  );
}

/**
 * Message du rappel WhatsApp J+1 (`BookingRule.nextDayReminderEnabled`) — recalculé à l'envoi,
 * pas un simple renvoi de `announceMessage` : mêmes courts fusionnés que l'annonce d'origine,
 * plus les votes reçus par heure (noms résolus via `memberNames`) et, uniquement si le moteur de
 * plan a dû en mobiliser, les prête-noms utilisés par heure. Un joueur compte comme "prête-nom
 * utilisé" pour une heure s'il apparaît dans les réservations de cette heure sans avoir voté "oui"
 * pour cette heure, et qu'il fait partie des volontaires du sondage (`volunteerSubstituteIds`,
 * ADR-017) ou des `substituteBookers` par défaut de la règle — même logique de détection que
 * `substitutesUsedInPlan` (planning/planJob.ts), réimplémentée ici en lecture seule sur le plan
 * déjà calculé.
 */
export function buildNextDayReminderMessage(
  bookingRule: BookingRule,
  targetDate: string,
  bookingPlanGroups: BookingPlanGroup[],
  confirmedPlayerIdsByTime: Record<string, string[]>,
  volunteerSubstituteIds: string[],
  memberNames: Record<string, string>,
  realBooking: boolean,
): string {
  const displayName = (userId: string): string => memberNames[userId] ?? userId;

  const bookedByGroup = bookingPlanGroups.map((g) => ({
    startTime: g.startTime,
    bookings: g.plan.proposedBookings.filter((b) => !g.outOfWindowSessionIds.includes(b.sessionId)),
  }));

  const slots = bookedByGroup.flatMap((g) =>
    g.bookings.map((b) => ({ court: b.court, beginTime: b.slotTime, endTime: b.slotEndTime })),
  );
  const merged = mergeContiguousSlotsByCourt(slots);
  const prefix = realBooking ? "🏸 Réservation(s) confirmée(s)" : "🏸 Réservation(s)";

  const votedTimes = bookingRule.candidateStartTimes.filter(
    (time) => (confirmedPlayerIdsByTime[time] ?? []).length > 0,
  );
  const votesBlock = votedTimes
    .map((time) => `• ${time} : ${(confirmedPlayerIdsByTime[time] ?? []).map(displayName).join(", ")}`)
    .join("\n");

  const substituteSet = new Set([...volunteerSubstituteIds, ...bookingRule.substituteBookers]);
  const substitutesByTime = new Map<string, Set<string>>();
  for (const g of bookedByGroup) {
    const confirmedForHour = new Set(confirmedPlayerIdsByTime[g.startTime] ?? []);
    for (const b of g.bookings) {
      for (const id of [b.userId, b.partnerId]) {
        if (id && substituteSet.has(id) && !confirmedForHour.has(id)) {
          if (!substitutesByTime.has(g.startTime)) substitutesByTime.set(g.startTime, new Set());
          substitutesByTime.get(g.startTime)!.add(id);
        }
      }
    }
  }
  const substituteTimes = bookingRule.candidateStartTimes.filter(
    (time) => (substitutesByTime.get(time)?.size ?? 0) > 0,
  );
  const substitutesBlock = substituteTimes
    .map((time) => `• ${time} : ${[...substitutesByTime.get(time)!].map(displayName).join(", ")}`)
    .join("\n");

  const votesSection = votesBlock ? `\n\nVotes reçus :\n${votesBlock}` : "";
  const substitutesSection = substitutesBlock ? `\n\nPrête-nom(s) utilisé(s) :\n${substitutesBlock}` : "";

  return (
    `🔔 Rappel — ${prefix} « ${bookingRule.id} »\n\n📅 ${targetDate}\n\n${formatMergedCourtSlots(merged)}` +
    `${votesSection}${substitutesSection}\n\nLe sondage WhatsApp est maintenant clôturé.`
  );
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
        `[${bookingRule.id}] Pas de "go" reçu — aucune annonce envoyée pour le ${targetDate}.`,
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
        if (realBooking) {
          await reserveAllForReal(deps, allProposedBookings);
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
        const message = `${prefix} « ${bookingRule.id} »\n\n📅 ${targetDate}\n\n${formatMergedCourtSlots(merged)}${capacityNote}`;

        await sendMessage(deps.huddleBot.client, notifyJid, message);

        if (notifyJid !== bookingRule.whatsappGroupJid) {
          // Synthèse cosmétique/secondaire — ne doit jamais faire échouer le nœud alors que
          // la réservation réelle et l'annonce principale ont déjà été envoyées.
          try {
            const memberNames = await fetchMemberNames(deps.resaSquash, bookingRule.resaSquashGroupId).catch(
              () => ({}),
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
          } catch (err) {
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
      `[${bookingRule.id}] Annonce envoyée pour le ${targetDate}${realBooking ? " (RÉSERVATION RÉELLE)" : ""} (WhatsApp ${notifyJid}).`,
    );

    return { announceMessage: message };
  };
}
