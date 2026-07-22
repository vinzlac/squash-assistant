import { reserveSlot, cancelReservation } from "../../mcp/resaSquash.js";
import { sendMessage } from "../../mcp/huddleBot.js";
import { countPlayersInSessions, computeShortfall } from "../capacityPlanning.js";
import { formatMergedCourtSlots, mergeContiguousSlotsByCourt } from "../slotMerge.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { emitEvent, withEventLogging } from "../emitEvent.js";
import type { GraphDependencies } from "../dependencies.js";
import type { BookingPlanGroup, PipelineStateType } from "../state.js";

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

export function createAnnounceNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate, goConfirmed, bookingPlanGroups, dryRun } = state;
    const groups = bookingPlanGroups ?? [];
    // Les réservations hors fenêtre acceptée (outOfWindowSessionIds, cf. ADR-014)
    // ne sont jamais réservées ni annoncées — seulement affichées à l'étape 3.
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

    // dryRun !== false : toute voie de confirmation autre que la case explicitement
    // décochée dans l'UI (bouton "go" par défaut, "go" Telegram) laisse dryRun à
    // true — voir waitForGoConfirmation.ts.
    const realBooking = dryRun === false;

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
        const capacityNote =
          unplacedPlayerCount > 0
            ? `\n\n⚠️ ${unplacedPlayerCount} joueur(s) n'ont pas pu être réservé(s) — capacité des courts dépassée.`
            : "";
        const message = `${prefix} « ${bookingRule.id} »\n\n📅 ${targetDate}\n\n${formatMergedCourtSlots(merged)}${capacityNote}`;

        await sendMessage(deps.huddleBot.client, bookingRule.whatsappGroupJid, message);
        return { result: message, detail: { step: "announced", realBooking, merged, message, unplacedPlayerCount } };
      },
    );

    await sendTelegramMessage(
      deps.telegram,
      `[${bookingRule.id}] Annonce envoyée pour le ${targetDate}${realBooking ? " (RÉSERVATION RÉELLE)" : ""}.`,
    );

    return { announceMessage: message };
  };
}
