import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import { getJobRunById, setJobRunPollClosedAt, setJobRunRecapInfo } from "../../jobRuns.js";
import { deleteMessage, sendMessage } from "../../mcp/huddleBot.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { findLastSuccessfulEventDetail, withEventLogging } from "../emitEvent.js";
import { pinBestEffort, unpinBestEffort } from "../pinning.js";
import { resolveVotes, type ResolvedVotes } from "../resolveVotes.js";
import { buildUnresolvedVotersMessage } from "../unresolvedVoters.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";
import { resolveAnnounceNotifyJid } from "./announce.js";
import { pollAnnouncedClosure } from "./pollQuestion.js";
import { buildRegistrationRecapMessage } from "./registrationRecap.js";

interface CollectContext {
  deps: GraphDependencies;
  bookingRule: BookingRule;
  ruleLabel: string;
  jobRunId: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Telegram non bloquant : un échec ici ne doit jamais faire rejouer le nœud. */
async function notify(deps: GraphDependencies, text: string): Promise<void> {
  await sendTelegramMessage(deps.telegram, text).catch((err) => {
    console.error("[collectVotes] Telegram non envoyé :", err);
  });
}

export function createCollectVotesNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate, pollRequestId } = state;
    const ctx: CollectContext = { deps, bookingRule, ruleLabel: bookingRule.name ?? bookingRule.id, jobRunId };
    const job = await getJobRunById(deps.db, bookingRule.id, jobRunId);

    // Sondage clôturé (relance après un arrêt en cours d'étape) : get_responses renverrait
    // « aucune_reponse » pour tout le monde, sans erreur. On ne relit jamais un sondage fermé.
    if (job?.pollClosedAt) return toStateUpdate(await votesFromLastCollect(deps, jobRunId));

    const votes = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "collect_votes", targetDate },
      async () => {
        if (!pollRequestId) {
          throw new Error(`pollRequestId manquant — SendPoll n'a pas été exécuté.`);
        }
        const result = await resolveVotes(deps, pollRequestId, bookingRule.candidateStartTimes);
        return { result, detail: { pollRequestId, ...result } };
      },
    );

    const announceJid = await resolveAnnounceNotifyJid(deps, bookingRule);
    await closePoll(ctx, job, announceJid);
    await sendTelegramSummaries(ctx, votes);
    await sendRegistrationRecap(ctx, targetDate, votes, announceJid);
    return toStateUpdate(votes);
  };
}

function toStateUpdate(votes: ResolvedVotes): Partial<PipelineStateType> {
  return {
    confirmedPlayerIdsByTime: votes.confirmedPlayerIdsByTime,
    volunteerSubstituteIds: votes.volunteerSubstituteIds,
    unresolvedVoters: votes.unresolvedVoters,
    voterNames: votes.voterNames,
  };
}

async function votesFromLastCollect(deps: GraphDependencies, jobRunId: string): Promise<ResolvedVotes> {
  const detail = (await findLastSuccessfulEventDetail(deps.db, jobRunId, "collect_votes")) as Partial<ResolvedVotes> | undefined;
  if (!detail?.confirmedPlayerIdsByTime) {
    // Le scheduler relaie l'erreur sur Telegram (Erreur CollectVotes / Erreur (relance)).
    throw new Error("sondage fermé, votes introuvables (aucune collecte réussie enregistrée pour ce job).");
  }
  return {
    confirmedPlayerIdsByTime: detail.confirmedPlayerIdsByTime,
    volunteerSubstituteIds: detail.volunteerSubstituteIds ?? [],
    unresolvedVoters: detail.unresolvedVoters ?? [],
    voterNames: detail.voterNames ?? {},
  };
}

/** Le sondage réellement envoyé annonçait-il sa clôture ? (`detail.question` de l'événement `poll`.) */
async function pollAnnouncedItsClosure(deps: GraphDependencies, jobRunId: string): Promise<boolean> {
  const detail = (await findLastSuccessfulEventDetail(deps.db, jobRunId, "poll")) as { question?: unknown } | undefined;
  return pollAnnouncedClosure(detail?.question);
}

/**
 * Clôture puis suppression du sondage (WhatsApp n'a pas de fermeture native), seulement si l'annonce
 * part sur le groupe du sondage (sinon mode test : désépinglage seul) et si le sondage envoyé annonçait
 * sa clôture. `poll_closed_at` est écrit AVANT `delete_message` (un pod tué entre les deux ne relira
 * jamais un sondage supprimé) et remis à null si la suppression échoue. Un sondage supprimé perd son
 * épinglage avec lui.
 */
async function closePoll(ctx: CollectContext, job: JobRun | undefined, announceJid: string): Promise<void> {
  const { deps, bookingRule, ruleLabel, jobRunId } = ctx;
  const pollMsgId = job?.pollMsgId ?? null;
  const deletable = announceJid === bookingRule.whatsappGroupJid && (await pollAnnouncedItsClosure(deps, jobRunId));
  if (!deletable) {
    await unpinPoll(ctx, pollMsgId);
    return;
  }
  if (!pollMsgId) {
    await notify(deps, `[${ruleLabel}] Sondage non supprimé : msgId inconnu.`);
    return;
  }
  try {
    await setJobRunPollClosedAt(deps.db, jobRunId, new Date());
  } catch (err) {
    await notify(deps, `[${ruleLabel}] Sondage non supprimé : clôture non enregistrée (poll_closed_at) : ${errorText(err)}`);
    await unpinPoll(ctx, pollMsgId);
    return;
  }
  try {
    await deleteMessage(deps.huddleBot.client, bookingRule.whatsappGroupJid, pollMsgId);
  } catch (err) {
    await notify(deps, `[${ruleLabel}] Suppression du sondage échouée : ${errorText(err)}`);
    await setJobRunPollClosedAt(deps.db, jobRunId, null).catch(async (resetErr) => {
      await notify(
        deps,
        `[${ruleLabel}] poll_closed_at non remis à null : ${errorText(resetErr)} — le sondage existe encore mais ne sera plus relu.`,
      );
    });
    await unpinPoll(ctx, pollMsgId);
  }
}

async function unpinPoll(ctx: CollectContext, pollMsgId: string | null): Promise<void> {
  if (!ctx.bookingRule.pinMessagesEnabled || !pollMsgId) return;
  await unpinBestEffort(ctx.deps, ctx.ruleLabel, ctx.bookingRule.whatsappGroupJid, pollMsgId, "du sondage");
}

async function sendTelegramSummaries(ctx: CollectContext, votes: ResolvedVotes): Promise<void> {
  const { deps, bookingRule, ruleLabel } = ctx;
  const perTime = bookingRule.candidateStartTimes
    .map((time) => `${time} : ${votes.confirmedPlayerIdsByTime[time]?.length ?? 0}`)
    .join(", ");
  const volunteerSuffix =
    votes.volunteerSubstituteIds.length > 0 ? `, ${votes.volunteerSubstituteIds.length} prête-nom(s) volontaire(s)` : "";
  await notify(deps, `[${ruleLabel}] Confirmés par heure — ${perTime}${volunteerSuffix}.`);
  if (votes.unresolvedVoters.length > 0) {
    await notify(deps, buildUnresolvedVotersMessage(ruleLabel, votes.unresolvedVoters));
  }
}

/** Récap WhatsApp des inscrits sur le groupe de l'annonce (dry-run compris), épinglé si la règle l'active. */
async function sendRegistrationRecap(
  ctx: CollectContext,
  targetDate: string,
  votes: ResolvedVotes,
  announceJid: string,
): Promise<void> {
  const { deps, bookingRule, ruleLabel, jobRunId } = ctx;
  try {
    const text = buildRegistrationRecapMessage({
      targetDate,
      candidateStartTimes: bookingRule.candidateStartTimes,
      confirmedPlayerIdsByTime: votes.confirmedPlayerIdsByTime,
      volunteerSubstituteIds: votes.volunteerSubstituteIds,
      unresolvedVoters: votes.unresolvedVoters,
      voterNames: votes.voterNames,
    });
    const { msgId } = await sendMessage(deps.huddleBot.client, announceJid, text);
    if (bookingRule.pinMessagesEnabled && msgId) {
      const pinned = await pinBestEffort(deps, ruleLabel, announceJid, msgId, "du récap");
      if (pinned) await rememberPinnedRecap(ctx, msgId, announceJid);
    }
  } catch (err) {
    await notify(deps, `[${ruleLabel}] Récap des inscrits non envoyé : ${errorText(err)}`);
  }
}

/** Le récap est déjà parti et épinglé : un échec de mémorisation ne doit pas le faire passer pour non envoyé. */
async function rememberPinnedRecap(ctx: CollectContext, msgId: string, jid: string): Promise<void> {
  try {
    await setJobRunRecapInfo(ctx.deps.db, ctx.jobRunId, { msgId, jid });
  } catch (err) {
    await notify(
      ctx.deps,
      `[${ctx.ruleLabel}] Récap des inscrits envoyé et épinglé mais non mémorisé (désépinglage automatique impossible) : ${errorText(err)}`,
    );
  }
}
