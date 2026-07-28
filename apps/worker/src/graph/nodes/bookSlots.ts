import { planGroupBookings, type GroupBookingPlan } from "../../mcp/resaSquash.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { buildPlanGroupBookingsParams } from "../buildBookingParams.js";
import {
  busyCourtsDuring,
  computeShortfall,
  conflictingSessionIds,
  countPlayersInSessions,
  courtIntervalsFromPlan,
  parseTeamrTime,
  splitByAvailabilityWindow,
  type CourtInterval,
} from "../capacityPlanning.js";
import { withEventLogging } from "../emitEvent.js";
import type { GraphDependencies } from "../dependencies.js";
import type { BookingPlanGroup } from "../state.js";
import type { PipelineStateType } from "../state.js";
import type { BookingRule } from "../../config.js";

/**
 * POC : toujours dryRun (voir docs/plan/squash-assistant-poc.md §2.2, §6) —
 * ce nœud n'appelle jamais reserve_slot. La confirmation "go" (nœud suivant,
 * waitForGoConfirmation) ne fait que valider le plan proposé pour l'annonce ;
 * le passage à une vraie réservation est un changement de scope explicite
 * pour une phase ultérieure du projet (Phase 4 du plan).
 *
 * Un appel plan_group_bookings par heure candidate ayant des joueurs
 * confirmés (voir resolveVotes/collectVotes) — chaque heure du sondage
 * multi-choix peut aboutir à un plan de réservation distinct, sur des courts
 * différents. Voir ADR-013.
 */
function notEnoughPlayersPlan(
  bookingRule: BookingRule,
  targetDate: string,
  startTime: string,
  confirmedPlayerIds: string[],
): GroupBookingPlan {
  return {
    dryRun: true,
    proposedBookings: [],
    warnings: [
      `Pas assez de joueurs confirmés à ${startTime} (${confirmedPlayerIds.length}/${bookingRule.minPlayersPerCourt} requis) pour proposer un créneau.`,
    ],
    meta: {
      courtsNeeded: 0,
      roundsPlanned: 0,
      dryRun: true,
      groupLabel: bookingRule.id,
      recurringWeekday: new Date(targetDate).getDay(),
      recurringStartTime: startTime,
      slotsPerPlayer: 0,
      groupMinSlotsPerPlayer: 0,
      groupMaxSlotsPerPlayer: 0,
      pairCount: 0,
    },
  };
}

/**
 * Calcule le plan pour une heure candidate, avec escalade automatique
 * min→max joueurs/court si la 1ère tentative (comportement configuré sur la
 * règle) ne suffit pas à caser tout le monde — voir ADR-014. Ne retente que
 * si la règle est en remplissage min (sinon déjà au maximum configuré, rien
 * à escalader) et ne garde la 2e tentative que si elle place réellement plus
 * de monde.
 */
async function planWithEscalation(
  deps: GraphDependencies,
  bookingRule: BookingRule,
  confirmedPlayerIds: string[],
  targetDate: string,
  startTime: string,
  usedTodayIds: ReadonlySet<string>,
  volunteerSubstituteIds: string[],
  busyCourts: readonly number[],
): Promise<GroupBookingPlan> {
  const params = buildPlanGroupBookingsParams(
    bookingRule,
    confirmedPlayerIds,
    targetDate,
    startTime,
    undefined,
    usedTodayIds,
    volunteerSubstituteIds,
    busyCourts,
  );
  const plan = await planGroupBookings(deps.resaSquash.client, params);

  if (!bookingRule.preferMinPlayersPerCourt || computeShortfall(plan) === 0) {
    return plan;
  }

  const escalatedParams = buildPlanGroupBookingsParams(
    bookingRule,
    confirmedPlayerIds,
    targetDate,
    startTime,
    false,
    usedTodayIds,
    volunteerSubstituteIds,
    busyCourts,
  );
  const escalatedPlan = await planGroupBookings(deps.resaSquash.client, escalatedParams);
  return escalatedPlan.proposedBookings.length > plan.proposedBookings.length ? escalatedPlan : plan;
}

/** Prête-noms (rule.substituteBookers ou volontaires du sondage, ADR-017) effectivement utilisés dans ce plan (présents mais pas attendus). */
function substitutesUsedInPlan(
  rule: BookingRule,
  volunteerSubstituteIds: string[],
  plan: GroupBookingPlan,
  confirmedPlayerIds: string[],
): string[] {
  const confirmedSet = new Set(confirmedPlayerIds);
  const substituteSet = new Set([...volunteerSubstituteIds, ...rule.substituteBookers]);
  const used = new Set<string>();
  for (const b of plan.proposedBookings) {
    for (const id of [b.userId, b.partnerId]) {
      if (id && substituteSet.has(id) && !confirmedSet.has(id)) {
        used.add(id);
      }
    }
  }
  return [...used];
}

export function createBookSlotsNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate, confirmedPlayerIdsByTime, volunteerSubstituteIds } = state;

    const bookingPlanGroups = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "booking", targetDate },
      async () => {
        const groups: BookingPlanGroup[] = [];
        // Un prête-nom déjà joueur confirmé à une autre heure ce jour-là n'est jamais
        // proposé comme substitut ailleurs — voir ADR-016. Mis à jour après chaque heure
        // traitée avec les prête-noms effectivement consommés par resa-squash.
        const usedTodayIds = new Set<string>(Object.values(confirmedPlayerIdsByTime).flat());
        // Courts occupés par les plans déjà calculés (heures candidates précédentes,
        // dans l'ordre de bookingRule.candidateStartTimes) — chaque heure donne lieu à
        // un appel plan_group_bookings indépendant côté resa-squash, qui ne sait donc
        // pas qu'un autre appel du même run a déjà retenu tel court sur un créneau qui
        // chevauche le sien. On déprioritise ces courts pour l'appel suivant
        // (busyCourtsDuring → buildPlanGroupBookingsParams) puis, en filet de sécurité,
        // on détecte et on écarte a posteriori (conflictingSessionIds) toute
        // réservation qui chevauche quand même un court déjà occupé.
        const courtOccupancy: CourtInterval[] = [];
        for (const startTime of bookingRule.candidateStartTimes) {
          const confirmedPlayerIds = confirmedPlayerIdsByTime[startTime] ?? [];

          // plan_group_bookings rejette expectedPlayerIds en-deçà de 2 éléments (validation MCP) —
          // pas assez de joueurs confirmés pour un court est un résultat normal (pas une erreur),
          // à traiter comme "aucun créneau proposé" plutôt que de laisser l'appel MCP échouer.
          if (confirmedPlayerIds.length < bookingRule.minPlayersPerCourt) {
            groups.push({
              startTime,
              plan: notEnoughPlayersPlan(bookingRule, targetDate, startTime, confirmedPlayerIds),
              outOfWindowSessionIds: [],
              conflictingSessionIds: [],
            });
            continue;
          }

          const startMinutes = parseTeamrTime(startTime);
          const tentativeEndMinutes =
            startMinutes != null ? startMinutes + bookingRule.maxReservationsPerPlayer * 45 : null;
          const busyCourts =
            startMinutes != null && tentativeEndMinutes != null
              ? busyCourtsDuring(courtOccupancy, startMinutes, tentativeEndMinutes)
              : [];

          const plan = await planWithEscalation(
            deps,
            bookingRule,
            confirmedPlayerIds,
            targetDate,
            startTime,
            usedTodayIds,
            volunteerSubstituteIds,
            busyCourts,
          );
          for (const id of substitutesUsedInPlan(bookingRule, volunteerSubstituteIds, plan, confirmedPlayerIds)) {
            usedTodayIds.add(id);
          }
          const { outOfWindowSessionIds } = splitByAvailabilityWindow(plan, startTime, bookingRule.availabilityWindowHours);
          const conflicts = conflictingSessionIds(plan, courtOccupancy);
          groups.push({ startTime, plan, outOfWindowSessionIds, conflictingSessionIds: conflicts });

          const nonBookableSessionIds = new Set([...outOfWindowSessionIds, ...conflicts]);
          courtOccupancy.push(...courtIntervalsFromPlan(plan, nonBookableSessionIds));
        }
        return { result: groups, detail: { step: "plan-proposed", groups } };
      },
    );

    const capacityWarnings = bookingPlanGroups
      .map((g) => {
        const outOfWindowPlayers = countPlayersInSessions(g.plan, g.outOfWindowSessionIds);
        const conflictingPlayers = countPlayersInSessions(g.plan, g.conflictingSessionIds);
        const shortfall = computeShortfall(g.plan) + outOfWindowPlayers + conflictingPlayers;
        if (shortfall === 0) return null;
        // Pas "capacité des courts insuffisante" : le manque peut aussi venir d'un
        // quota/garde-fou côté resa-squash (ex. plafond de résas/jour du titulaire
        // de la clé API) plutôt que d'un vrai manque de courts — voir le détail du
        // plan (warnings) à l'étape 3 pour le motif exact.
        return `⚠️ ${g.startTime} : ~${shortfall} joueur(s) risquent de ne pas avoir de créneau — voir le détail à l'étape 3.`;
      })
      .filter((w): w is string => w !== null);

    const summaryParts = bookingPlanGroups.map((g) =>
      g.plan.proposedBookings.length === 0
        ? `${g.startTime} : aucun créneau (${g.plan.warnings.join(" ")})`
        : `${g.startTime} :\n` +
          g.plan.proposedBookings
            .map((b) => {
              const marker = g.conflictingSessionIds.includes(b.sessionId)
                ? " [conflit de court, non réservé]"
                : g.outOfWindowSessionIds.includes(b.sessionId)
                  ? " [hors fenêtre, non réservé]"
                  : "";
              return (
                `  • ${b.slotTime}-${b.slotEndTime} (court ${b.court}) — ${b.userId}${b.partnerId ? ` et ${b.partnerId}` : ""}` +
                marker
              );
            })
            .join("\n"),
    );
    const totalProposed = bookingPlanGroups.reduce((n, g) => n + g.plan.proposedBookings.length, 0);
    const warningsBlock = capacityWarnings.length > 0 ? `${capacityWarnings.join("\n")}\n\n` : "";
    const summary =
      totalProposed === 0
        ? `[${bookingRule.id}] Aucun créneau proposé pour le ${targetDate} (toutes heures confondues).\n${summaryParts.join("\n")}`
        : `[${bookingRule.id}] ${warningsBlock}Plan de réservation (dry-run) pour le ${targetDate} :\n${summaryParts.join("\n\n")}\n\nRéponds "go" pour confirmer.`;

    await sendTelegramMessage(deps.telegram, summary);

    return { bookingPlanGroups };
  };
}

export function hasProposedBookings(state: PipelineStateType): boolean {
  return (state.bookingPlanGroups ?? []).some((g) => g.plan.proposedBookings.length > 0);
}
