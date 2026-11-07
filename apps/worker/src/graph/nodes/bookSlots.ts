import { getJobRunById } from "../../jobRuns.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { countUnbookedConfirmedPlayersByTime } from "../unbookedPlayers.js";
import { withEventLogging } from "../emitEvent.js";
import { computeJobPlan } from "../computeJobPlan.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";
import { completeNamesFromFavorites, fetchGroupMemberDirectory } from "./announce.js";
import { resolvePlayerIdsInText } from "../formatWarning.js";
import { refreshVotesFromEvents } from "../../roster/refreshVotes.js";
import { saveRosterPlanSnapshot } from "../../roster/rosterStore.js";

export function createBookSlotsNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate } = state;
    const job = jobRunId ? await getJobRunById(deps.db, bookingRule.id, jobRunId) : undefined;
    // Roster vivant (spec 2026-10-24-roster-desistements §4.3, CA-2) : les votes arrivés depuis la
    // collecte entrent dans le plan ; job legacy (pas de photo) → votes de l'état, comme avant.
    const refreshed = job ? await refreshVotesFromEvents(deps, job, bookingRule, bookingRule.name ?? bookingRule.id) : null;
    const confirmedPlayerIdsByTime = refreshed?.resolved.confirmedPlayerIdsByTime ?? state.confirmedPlayerIdsByTime;
    const volunteerSubstituteIds = refreshed?.resolved.volunteerSubstituteIds ?? state.volunteerSubstituteIds;

    const bookingPlanGroups = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "booking", targetDate },
      async () => {
        const groups = await computeJobPlan(
          deps,
          bookingRule,
          targetDate,
          confirmedPlayerIdsByTime,
          volunteerSubstituteIds,
        );
        return { result: groups, detail: { step: "plan-proposed", groups } };
      },
    );
    // Après le calcul seulement : un plan en échec n'enregistre rien.
    if (refreshed && job) await saveRosterPlanSnapshot(deps.db, job.id, refreshed.snapshot);

    // Joueurs confirmés sans aucun créneau dans la fenêtre (même compte que l'annonce WhatsApp,
    // spec §4/§6) — un round manquant d'un groupe qui joue n'est pas une alerte.
    const unbookedByTime = countUnbookedConfirmedPlayersByTime(bookingPlanGroups, confirmedPlayerIdsByTime ?? {});
    const capacityWarnings = bookingPlanGroups
      .map((g) => {
        const unbooked = unbookedByTime[g.startTime] ?? 0;
        if (unbooked === 0) return null;
        return `⚠️ ${g.startTime} : ~${unbooked} joueur(s) risquent de ne pas avoir de créneau — voir le détail à l'étape 3.`;
      })
      .filter((w): w is string => w !== null);

    const { names: groupNames } = await fetchGroupMemberDirectory(
      deps.resaSquash,
      bookingRule.resaSquashGroupId,
    ).catch(() => ({ names: {} as Record<string, string> }));
    // Le joker (ADR-024) n'est pas membre du groupe : sans ce complément par les favoris, ses
    // lignes s'affichaient avec son userId brut dans ce message (constaté 2026-09-06).
    const memberNames = await completeNamesFromFavorites(
      deps.resaSquash,
      groupNames,
      bookingPlanGroups.flatMap((g) => g.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId])),
    );
    const displayName = (userId: string): string => memberNames[userId] ?? userId;
    // Les notes du moteur de plan citent les joueurs par id : on les résout ici, où
    // l'annuaire du groupe est disponible.
    const humanize = (text: string): string => resolvePlayerIdsInText(text, memberNames);

    const summaryParts = bookingPlanGroups.map((g) =>
      g.plan.proposedBookings.length === 0
        ? `${g.startTime} : aucun créneau (${humanize(g.plan.warnings.join(" "))})`
        : `${g.startTime} :\n` +
          g.plan.proposedBookings
            .map(
              (b) =>
                `  • ${b.slotTime}-${b.slotEndTime} (court ${b.court}) — ${displayName(b.userId)}${b.partnerId ? ` et ${displayName(b.partnerId)}` : ""}` +
                (g.outOfWindowSessionIds.includes(b.sessionId) ? " [hors fenêtre, non réservé]" : ""),
            )
            .join("\n"),
    );
    const totalProposed = bookingPlanGroups.reduce((n, g) => n + g.plan.proposedBookings.length, 0);
    const warningsBlock = capacityWarnings.length > 0 ? `${capacityWarnings.join("\n")}\n\n` : "";
    // Job auto + confirmation Telegram désactivée (requireTelegramGoForAutoJobs=false) : la
    // reprise du graphe (resumeAfterPlanInterrupt, scheduler.ts) invoque "go-real" sans attendre
    // de message "go" — inutile, voire trompeur, de le demander ici.
    const goHint =
      job?.auto && bookingRule.requireTelegramGoForAutoJobs === false
        ? `\n\nRéservation RÉELLE en cours automatiquement — job automatique, confirmation "go" désactivée pour cette règle.`
        : job?.auto
          ? `\n\nRéponds "go" pour confirmer — réservation RÉELLE (job automatique).`
          : `\n\nRéponds "go" pour confirmer (dry-run via Telegram ; pour une vraie réservation, utilise l'UI en décochant Dry-run).`;
    const summary =
      totalProposed === 0
        ? `[${bookingRule.name ?? bookingRule.id}] Aucun créneau proposé pour le ${targetDate} (toutes heures confondues).\n${summaryParts.join("\n")}`
        : `[${bookingRule.name ?? bookingRule.id}] ${warningsBlock}Plan de réservation (planification dry-run) pour le ${targetDate} :\n${summaryParts.join("\n\n")}${goHint}`;

    await sendTelegramMessage(deps.telegram, summary);

    // Votes recalculés renvoyés dans l'état : l'annonce et le « Recalculer » partent de ce plan.
    return refreshed ? { bookingPlanGroups, ...refreshed.resolved } : { bookingPlanGroups };
  };
}

export function hasProposedBookings(state: PipelineStateType): boolean {
  return (state.bookingPlanGroups ?? []).some((g) => g.plan.proposedBookings.length > 0);
}
