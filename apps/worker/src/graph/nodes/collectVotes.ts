import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import { getJobRunById, setJobRunPollClosedAt, setJobRunRecapInfo } from "../../jobRuns.js";
import { deleteMessage, sendMessage } from "../../mcp/huddleBot.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { emitEvent, findLastSuccessfulEvent, findLastSuccessfulEventDetail, withEventLogging } from "../emitEvent.js";
import { pinBestEffort, unpinBestEffort } from "../pinning.js";
import { resolveVotes, type ResolvedVotes } from "../resolveVotes.js";
import { buildUnresolvedVotersMessage } from "../unresolvedVoters.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";
import { resolveAnnounceNotifyJid } from "./announce.js";
import { POLL_DELETE_MAX_AGE_HOURS, pollAnnouncedClosure } from "./pollQuestion.js";
import { buildRegistrationRecapMessage } from "./registrationRecap.js";

const HOUR_MS = 60 * 60 * 1000;

interface CollectContext {
  deps: GraphDependencies;
  bookingRule: BookingRule;
  ruleLabel: string;
  jobRunId: string;
  targetDate: string;
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
    const ctx: CollectContext = { deps, bookingRule, ruleLabel: bookingRule.name ?? bookingRule.id, jobRunId, targetDate };
    const job = await getJobRunById(deps.db, bookingRule.id, jobRunId);

    // Sondage clôturé (relance après un arrêt en cours d'étape) : get_responses renverrait
    // « aucune_reponse » pour tout le monde, sans erreur. On ne relit jamais un sondage fermé.
    if (job?.pollClosedAt) {
      const votes = await votesFromLastCollect(deps, jobRunId);
      await retryPollDeletion(ctx, job.pollMsgId ?? null);
      await sendTelegramSummaries(ctx, votes);
      return toStateUpdate(votes);
    }

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

    if (votes.respondentCount === 0) {
      await keepPollAfterEmptyRead(ctx, job, votes);
      return toStateUpdate(votes);
    }

    const announceJid = await resolveAnnounceNotifyJid(deps, bookingRule);
    const pollDeleted = await closePoll(ctx, job, announceJid);
    // Mode test : le récap part sur un autre groupe que le sondage, la clôture y est simulée.
    const pollClosed = pollDeleted || announceJid !== bookingRule.whatsappGroupJid;
    await sendTelegramSummaries(ctx, votes);
    await sendRegistrationRecap(ctx, targetDate, votes, announceJid, pollClosed);
    return toStateUpdate(votes);
  };
}

/**
 * Personne n'a répondu, pas même « Non » : plus probablement des votes perdus côté huddle-bot (store
 * mémoire vidé par un redémarrage) qu'un groupe muet. Rien d'irréversible : sondage conservé
 * (`poll_closed_at` reste null, une relance le relira), désépinglage seul, pas de récap WhatsApp.
 */
async function keepPollAfterEmptyRead(ctx: CollectContext, job: JobRun | undefined, votes: ResolvedVotes): Promise<void> {
  await unpinPoll(ctx, job?.pollMsgId ?? null);
  await sendTelegramSummaries(ctx, votes);
  await notify(
    ctx.deps,
    `[${ctx.ruleLabel}] ⚠️ Aucune réponse lue au sondage (personne, même « Non ») — possible perte des votes côté huddle-bot (redémarrage ?). ` +
      "Sondage conservé, aucun récap envoyé : vérifier les votes dans le groupe, puis « Recalculer le plan » si besoin.",
  );
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

/** Événement `poll` du job : le sondage réellement envoyé annonçait-il sa clôture, et quand est-il parti ? */
async function readSentPoll(deps: GraphDependencies, jobRunId: string): Promise<{ announcedClosure: boolean; sentAt: Date | null }> {
  const event = await findLastSuccessfulEvent(deps.db, jobRunId, "poll");
  const detail = event?.detail as { question?: unknown } | undefined;
  return { announcedClosure: pollAnnouncedClosure(detail?.question), sentAt: event?.createdAt ?? null };
}

/**
 * Le sondage est-il trop ancien (ou de date inconnue) pour être supprimé pour tous ? `null` s'il est
 * supprimable, sinon son âge en heures entières (arrondi inférieur), `ageHours: null` si la date manque.
 */
function pollTooOldToDelete(sentAt: Date | null, now: Date): { ageHours: number | null } | null {
  if (!sentAt) return { ageHours: null };
  const ageHours = (now.getTime() - sentAt.getTime()) / HOUR_MS;
  return ageHours <= POLL_DELETE_MAX_AGE_HOURS ? null : { ageHours: Math.floor(ageHours) };
}

/**
 * Clôture puis suppression du sondage (WhatsApp n'a pas de fermeture native), seulement si l'annonce
 * part sur le groupe du sondage (sinon mode test : désépinglage seul) et si le sondage envoyé annonçait
 * sa clôture, et seulement s'il a moins de POLL_DELETE_MAX_AGE_HOURS. `poll_closed_at` est écrit AVANT `delete_message` (un pod tué entre les deux ne relira
 * jamais un sondage supprimé) et remis à null si la suppression échoue. Un sondage supprimé perd son
 * épinglage avec lui. Renvoie vrai seulement si le sondage a été supprimé.
 */
async function closePoll(ctx: CollectContext, job: JobRun | undefined, announceJid: string): Promise<boolean> {
  const { deps, bookingRule, ruleLabel, jobRunId } = ctx;
  const pollMsgId = job?.pollMsgId ?? null;
  const sentPoll = announceJid === bookingRule.whatsappGroupJid ? await readSentPoll(deps, jobRunId) : undefined;
  if (!sentPoll?.announcedClosure) {
    await unpinPoll(ctx, pollMsgId);
    return false;
  }
  const tooOld = pollTooOldToDelete(sentPoll.sentAt, new Date());
  if (tooOld) {
    const reason =
      tooOld.ageHours === null
        ? "date d'envoi introuvable"
        : `envoyé il y a ${tooOld.ageHours} h (au-delà de ${POLL_DELETE_MAX_AGE_HOURS} h, WhatsApp ne permet plus de le supprimer pour tous)`;
    await notify(deps, `[${ruleLabel}] Sondage non supprimé : ${reason} — à supprimer à la main dans le groupe si besoin.`);
    await unpinPoll(ctx, pollMsgId);
    return false;
  }
  if (!pollMsgId) {
    await notify(deps, `[${ruleLabel}] Sondage non supprimé : msgId inconnu.`);
    return false;
  }
  try {
    await setJobRunPollClosedAt(deps.db, jobRunId, new Date());
  } catch (err) {
    await notify(deps, `[${ruleLabel}] Sondage non supprimé : clôture non enregistrée (poll_closed_at) : ${errorText(err)}`);
    await unpinPoll(ctx, pollMsgId);
    return false;
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
    return false;
  }
  await recordPollDeleted(ctx, pollMsgId);
  return true;
}

/**
 * Trace de la suppression réussie : une relance ne la retente pas (elle recevrait « Message not found »
 * et enverrait un faux « suppression non confirmée »). Best-effort : un échec d'écriture est signalé
 * sur Telegram, la relance retentera alors comme avant.
 */
async function recordPollDeleted(ctx: CollectContext, pollMsgId: string): Promise<void> {
  const { deps, bookingRule, jobRunId, targetDate, ruleLabel } = ctx;
  try {
    await emitEvent(deps.db, {
      bookingRuleId: bookingRule.id,
      jobRunId,
      type: "poll_deleted",
      status: "success",
      targetDate,
      detail: { pollMsgId },
    });
  } catch (err) {
    await notify(deps, `[${ruleLabel}] Sondage supprimé mais événement poll_deleted non enregistré : ${errorText(err)}`);
  }
}

/**
 * Relance après clôture : la suppression a pu ne pas aboutir (pod tué juste après `poll_closed_at`).
 * Rien à faire si un événement `poll_deleted` atteste la suppression. Sinon retentée en best-effort,
 * sauf si le sondage a dépassé POLL_DELETE_MAX_AGE_HOURS (même garde-fou qu'à la collecte) ; tout échec
 * est signalé, « Message not found » compris : sans `poll_deleted`, on ne distingue pas un sondage déjà
 * supprimé d'un store huddle-bot perdu. Réussite → `poll_deleted` écrit (une seconde relance ne réalerte
 * pas) ; échec ou suppression non tentée → désépinglage best-effort. `poll_closed_at` n'est jamais remis
 * à null ici : les votes sont déjà repris. Jamais de récap WhatsApp à la relance.
 */
async function retryPollDeletion(ctx: CollectContext, pollMsgId: string | null): Promise<void> {
  if (!pollMsgId) return;
  if (await findLastSuccessfulEvent(ctx.deps.db, ctx.jobRunId, "poll_deleted")) return;
  const { sentAt } = await readSentPoll(ctx.deps, ctx.jobRunId);
  const tooOld = pollTooOldToDelete(sentAt, new Date());
  if (tooOld) {
    const reason =
      tooOld.ageHours === null
        ? "date d'envoi du sondage introuvable"
        : `sondage envoyé il y a ${tooOld.ageHours} h (au-delà de ${POLL_DELETE_MAX_AGE_HOURS} h)`;
    await notify(
      ctx.deps,
      `[${ctx.ruleLabel}] Relance de la collecte : ${reason}, suppression non retentée — ` +
        "vérifier dans le groupe et le supprimer à la main s'il est encore là.",
    );
    await unpinPoll(ctx, pollMsgId);
    return;
  }
  try {
    await deleteMessage(ctx.deps.huddleBot.client, ctx.bookingRule.whatsappGroupJid, pollMsgId);
  } catch (err) {
    await notify(
      ctx.deps,
      `[${ctx.ruleLabel}] Relance de la collecte : suppression du sondage non confirmée (${errorText(err)}) — ` +
        "vérifier dans le groupe et le supprimer à la main s'il est encore là.",
    );
    await unpinPoll(ctx, pollMsgId);
    return;
  }
  await recordPollDeleted(ctx, pollMsgId);
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
  pollClosed: boolean,
): Promise<void> {
  const { deps, bookingRule, ruleLabel } = ctx;
  try {
    const text = buildRegistrationRecapMessage({
      targetDate,
      candidateStartTimes: bookingRule.candidateStartTimes,
      confirmedPlayerIdsByTime: votes.confirmedPlayerIdsByTime,
      volunteerSubstituteIds: votes.volunteerSubstituteIds,
      unresolvedVoters: votes.unresolvedVoters,
      voterNames: votes.voterNames,
      pollClosed,
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
