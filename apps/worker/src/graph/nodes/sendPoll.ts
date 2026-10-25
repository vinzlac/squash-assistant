import { filterCandidateTimesByClosures } from "../../closures/filterCandidateTimes.js";
import { loadClubClosuresForDate } from "../../closures/loadClubClosures.js";
import { askPoll, sendMessage } from "../../mcp/huddleBot.js";
import { findPreviousJobWithRoster, findPreviousPinnedAnnounce, findPreviousPinnedRecap, setJobRunAnnounceInfo, setJobRunPollInfo, setJobRunRecapInfo } from "../../jobRuns.js";
import { retryOrphanUnpin, withdrawRoster, type RosterPublishContext } from "../../roster/publishRoster.js";
import { setPollUnpinnedAt } from "../../roster/rosterStore.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { withEventLogging } from "../emitEvent.js";
import { pinBestEffort, unpinBestEffort } from "../pinning.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";
import { buildClubClosedMessage, buildPollOptions, buildPollQuestion } from "./pollQuestion.js";

export function createSendPollNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate } = state;
    const ruleLabel = bookingRule.name ?? bookingRule.id;
    await unpinPreviousAnnounce(deps, bookingRule.id, ruleLabel, jobRunId);
    // Nettoyage best-effort : une erreur ici ne doit jamais empêcher le sondage hebdomadaire.
    try {
      await unpinPreviousRecap(deps, bookingRule.id, ruleLabel, jobRunId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await sendTelegramMessage(deps.telegram, `[${ruleLabel}] Nettoyage du récap précédent échoué : ${reason}`).catch(
        () => {},
      );
    }

    await cleanupPreviousRoster(deps, bookingRule, ruleLabel, jobRunId);

    const closures = await loadClubClosuresForDate(deps.db, targetDate);
    const { openTimes, closedTimes } = filterCandidateTimesByClosures(
      targetDate,
      bookingRule.candidateStartTimes,
      closures,
    );

    if (openTimes.length === 0) {
      const message = buildClubClosedMessage(
        targetDate,
        closures.map((c) => c.label),
      );
      await withEventLogging(
        deps,
        { bookingRuleId: bookingRule.id, jobRunId, type: "club-closed", targetDate },
        async () => {
          await sendMessage(deps.huddleBot.client, bookingRule.whatsappGroupJid, message);
          return { result: message, detail: { message, closedTimes } };
        },
      );
      await sendTelegramMessage(
        deps.telegram,
        `[${bookingRule.id}] Club fermé le ${targetDate} — message envoyé, pipeline arrêté.`,
      );
      return { clubClosed: true };
    }

    const { requestId, msgId } = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "poll", targetDate },
      async () => {
        // Le roster vivant remplace l'annonce de clôture (spec roster-desistements §4.1).
        const question = buildPollQuestion(targetDate, openTimes, closedTimes, null);
        const options = buildPollOptions(openTimes);
        const { requestId, msgId } = await askPoll(
          deps.huddleBot.client,
          bookingRule.whatsappGroupJid,
          question,
          options,
        );
        await setJobRunPollInfo(deps.db, jobRunId, requestId, msgId);
        return { result: { requestId, msgId }, detail: { question, options, requestId, msgId } };
      },
    );

    if (bookingRule.pinMessagesEnabled && msgId) {
      await pinBestEffort(deps, ruleLabel, bookingRule.whatsappGroupJid, msgId, "du sondage");
    }

    await sendTelegramMessage(
      deps.telegram,
      `[${bookingRule.id}] Sondage envoyé pour le ${targetDate} (requestId=${requestId}).`,
    );

    return { pollRequestId: requestId, clubClosed: false };
  };
}

// Indépendant de pinMessagesEnabled : une règle désactivée entre-temps nettoie quand même
// ce qu'elle avait épinglé. Oubliée seulement si le désépinglage a réussi.
async function unpinPreviousAnnounce(
  deps: GraphDependencies,
  bookingRuleId: string,
  ruleLabel: string,
  jobRunId: string,
): Promise<void> {
  const previous = await findPreviousPinnedAnnounce(deps.db, bookingRuleId, jobRunId);
  if (!previous) return;
  const unpinned = await unpinBestEffort(deps, ruleLabel, previous.jid, previous.msgId, "de l'annonce précédente");
  if (unpinned) await setJobRunAnnounceInfo(deps.db, previous.jobId, null);
}

// Même principe que l'annonce : indépendant de pinMessagesEnabled, oublié seulement si le désépinglage a réussi.
async function unpinPreviousRecap(
  deps: GraphDependencies,
  bookingRuleId: string,
  ruleLabel: string,
  jobRunId: string,
): Promise<void> {
  const previous = await findPreviousPinnedRecap(deps.db, bookingRuleId, jobRunId);
  if (!previous) return;
  const unpinned = await unpinBestEffort(deps, ruleLabel, previous.jid, previous.msgId, "du récap précédent");
  if (unpinned) await setJobRunRecapInfo(deps.db, previous.jobId, null);
}

/** Exécute une étape de nettoyage ; une erreur donne un Telegram et ne bloque jamais la suivante. */
async function cleanupStep(deps: GraphDependencies, ruleLabel: string, what: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await sendTelegramMessage(deps.telegram, `[${ruleLabel}] Nettoyage ${what} échoué : ${reason}`).catch(() => {});
  }
}

/**
 * Au sondage suivant, nettoie le job précédent de la règle (ADR-034 point 4), indépendamment de
 * pinMessagesEnabled : désépingle son sondage, désépingle (sans supprimer) son roster en gardant
 * msgId et empreinte, retente son orphelin sans rien réépingler (PC2-7). Best-effort.
 */
async function cleanupPreviousRoster(
  deps: GraphDependencies,
  bookingRule: PipelineStateType["bookingRule"],
  ruleLabel: string,
  jobRunId: string,
): Promise<void> {
  let previous;
  try {
    previous = await findPreviousJobWithRoster(deps.db, bookingRule.id, jobRunId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await sendTelegramMessage(deps.telegram, `[${ruleLabel}] Nettoyage du roster précédent échoué : ${reason}`).catch(() => {});
    return;
  }
  if (!previous) return;
  const groupJid = previous.ruleSnapshot?.whatsappGroupJid ?? bookingRule.whatsappGroupJid;
  const job = previous;
  const ctx: RosterPublishContext = {
    deps,
    job,
    ruleLabel,
    pinEnabled: false,
    notifyJid: job.rosterJid ?? groupJid,
    now: new Date(),
  };

  if (job.rosterPhoto && job.pollMsgId && !job.pollUnpinnedAt) {
    await cleanupStep(deps, ruleLabel, "du sondage précédent", async () => {
      const unpinned = await unpinBestEffort(deps, ruleLabel, groupJid, job.pollMsgId!, "du sondage précédent");
      // Écrit seulement en cas de réussite : sinon la passe sondage du tick réessaie (P2-7).
      if (unpinned) await setPollUnpinnedAt(deps.db, job.id, ctx.now);
    });
  }
  if (job.rosterMsgId) {
    await cleanupStep(deps, ruleLabel, "du roster précédent", async () => {
      const done = await withdrawRoster(ctx, { unpinOnly: true });
      if (!done) {
        await sendTelegramMessage(deps.telegram, `[${ruleLabel}] Roster précédent en cours de publication : désépinglage laissé au tick.`).catch(() => {});
      }
    });
  }
  if (job.rosterOrphan) {
    await cleanupStep(deps, ruleLabel, "de l'ancien roster orphelin", () => retryOrphanUnpin(ctx));
  }
}
