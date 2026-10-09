import { filterCandidateTimesByClosures } from "../../closures/filterCandidateTimes.js";
import { loadClubClosuresForDate } from "../../closures/loadClubClosures.js";
import { askPoll, sendMessage } from "../../mcp/huddleBot.js";
import { findPreviousPinnedAnnounce, findPreviousPinnedRecap, setJobRunAnnounceInfo, setJobRunPollInfo, setJobRunRecapInfo } from "../../jobRuns.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { withEventLogging } from "../emitEvent.js";
import { pinBestEffort, unpinBestEffort } from "../pinning.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";
import { buildClubClosedMessage, buildPollOptions, buildPollQuestion, formatPollClosureDeadline } from "./pollQuestion.js";

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
        const closureDeadline = formatPollClosureDeadline(
          targetDate,
          bookingRule.decisionDaysBefore,
          bookingRule.decisionTime,
          new Date(),
        );
        const question = buildPollQuestion(targetDate, openTimes, closedTimes, closureDeadline);
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
