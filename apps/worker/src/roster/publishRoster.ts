import type { JobRun } from "@squash-assistant/db/schema";
import type { RosterOrphan } from "@squash-assistant/db/rosterTypes";
import type { GraphDependencies } from "../graph/dependencies.js";
import { POLL_DELETE_MAX_AGE_HOURS } from "../graph/nodes/pollQuestion.js";
import { PIN_DURATION, PIN_DURATION_MS } from "../graph/pinning.js";
import { deleteMessage, pinMessage, sendMessage, unpinMessage } from "../mcp/huddleBot.js";
import { sendTelegramMessage } from "../telegram/telegram.js";
import { rosterFingerprint } from "./rosterMessage.js";
import {
  claimRosterPublish,
  releaseRosterPublish,
  setRosterFingerprint,
  setRosterMessage,
  setRosterOrphan,
  setRosterPinnedAt,
} from "./rosterStore.js";

// Écrivain unique du roster vivant WhatsApp (spec 2026-10-24-roster-desistements) : publication,
// retrait de l'ancien, épinglage, roster orphelin. Toute écriture se fait sous claim et se décide
// sur la ligne fraîche renvoyée par le claim, jamais sur `ctx.job` (P1-1). Après un envoi réussi,
// suppression / (dés)épinglage / Telegram sont best-effort.

export interface RosterPublishContext {
  deps: Pick<GraphDependencies, "db" | "huddleBot" | "telegram">;
  job: JobRun;
  ruleLabel: string;
  pinEnabled: boolean;
  notifyJid: string;
  /** Date du claim : la même valeur est rendue à `releaseRosterPublish`. */
  now: Date;
}

export type PublishOutcome = "published" | "unchanged" | "busy" | "failed";
export type RosterPhase = "provisional" | "final";

const HOUR_MS = 3600 * 1000;

/** `job.id + motif` déjà signalés sur Telegram — un seul message par motif et par job (perdu au redémarrage). */
const rosterTelegramLogged = new Set<string>();

export function __resetRosterTelegramLogForTests(): void {
  rosterTelegramLogged.clear();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function logOnce(ctx: RosterPublishContext, motif: string, text: string): Promise<void> {
  const key = `${ctx.job.id}:${motif}`;
  if (rosterTelegramLogged.has(key)) return;
  rosterTelegramLogged.add(key);
  await sendTelegramMessage(ctx.deps.telegram, `[${ctx.ruleLabel}] ${text}`).catch(() => {});
}

/** Exécute `action` sous claim sur la ligne fraîche ; null si le claim est déjà pris. Release toujours. */
async function withRosterClaim<T>(ctx: RosterPublishContext, action: (fresh: JobRun) => Promise<T>): Promise<T | null> {
  const { db } = ctx.deps;
  const claim = await claimRosterPublish(db, ctx.job.id, ctx.now);
  if (!claim) return null;
  try {
    if (claim.reclaimedStale) {
      await logOnce(ctx, "stale-claim", "Claim de publication du roster périmé repris : possible doublon du roster sur WhatsApp.");
    }
    return await action(claim.job);
  } finally {
    await releaseRosterPublish(db, ctx.job.id, ctx.now);
  }
}

/** Moins de POLL_DELETE_MAX_AGE_HOURS : WhatsApp permet encore de le supprimer pour tous. */
function isDeletable(sentAt: Date | null, now: Date): boolean {
  return sentAt != null && now.getTime() - sentAt.getTime() < POLL_DELETE_MAX_AGE_HOURS * HOUR_MS;
}

/** Échéance de l'épinglage, calculée sur la ligne fraîche avant toute écriture (PC3-4). */
function orphanOf(msgId: string, jid: string, pinnedAt: Date): RosterOrphan {
  return { msgId, jid, expiresAt: new Date(pinnedAt.getTime() + PIN_DURATION_MS).toISOString() };
}

/**
 * Retire le roster courant de `fresh` (CA-9) : suppression s'il a moins de 48 h (jamais avec
 * `unpinOnly`), sinon ou en cas d'échec désépinglage s'il est épinglé. Un désépinglage raté le
 * mémorise comme orphelin (repris par le tick). Renvoie true si un orphelin a été créé.
 */
async function retireRoster(ctx: RosterPublishContext, fresh: JobRun, unpinOnly: boolean): Promise<boolean> {
  const { rosterMsgId: msgId, rosterJid: jid, rosterPinnedAt: pinnedAt } = fresh;
  if (!msgId || !jid) return false;
  const { client } = ctx.deps.huddleBot;
  if (!unpinOnly && isDeletable(fresh.rosterSentAt, ctx.now)) {
    try {
      await deleteMessage(client, jid, msgId);
      return false;
    } catch (err) {
      await logOnce(ctx, "delete-failed", `Suppression de l'ancien roster (${msgId}) échouée : ${errorText(err)}`);
    }
  }
  if (!pinnedAt) return false;
  const orphan = orphanOf(msgId, jid, pinnedAt);
  try {
    await unpinMessage(client, jid, msgId);
    return false;
  } catch (err) {
    // Pas d'orphelin existant écrasé : un orphelin présent implique `rosterPinnedAt` nul (on n'épingle
    // jamais tant qu'il existe), donc on ne passe jamais ici dans ce cas.
    await setRosterOrphan(ctx.deps.db, fresh.id, orphan);
    await logOnce(
      ctx,
      "unpin-failed",
      `Désépinglage de l'ancien roster (${msgId}) échoué : ${errorText(err)} — nouvel essai chaque minute, aucun roster épinglé d'ici là.`,
    );
    return true;
  }
}

/** Épingle `msgId` (best-effort) puis mémorise `roster_pinned_at`. */
async function pinRoster(ctx: RosterPublishContext, jid: string, msgId: string): Promise<void> {
  try {
    await pinMessage(ctx.deps.huddleBot.client, jid, msgId, PIN_DURATION);
  } catch (err) {
    await logOnce(ctx, "pin-failed", `Épinglage du roster (${msgId}) échoué : ${errorText(err)}`);
    return;
  }
  await setRosterPinnedAt(ctx.deps.db, ctx.job.id, ctx.now);
}

async function publishOnFreshRow(
  ctx: RosterPublishContext,
  fresh: JobRun,
  text: string,
  fingerprint: string,
  phase: RosterPhase,
): Promise<PublishOutcome> {
  if (fingerprint === fresh.rosterFingerprint) return "unchanged";
  // Job annulé entre-temps (fermeture PUC) : rien ne doit être republié.
  if (fresh.cancelledAt) return "unchanged";
  // Le définitif ne se fait jamais remplacer par un provisoire.
  if (phase === "provisional" && fresh.rosterFinal) return "unchanged";
  const { db, huddleBot } = ctx.deps;
  let sent: { msgId?: string };
  try {
    sent = await sendMessage(huddleBot.client, ctx.notifyJid, text);
  } catch (err) {
    // Définitif (B2-5) : seul Telegram de l'échec, étape 4 comprise ; motif distinct du provisoire.
    if (phase === "final") {
      await logOnce(
        ctx,
        "final-send-failed",
        `⚠️ Roster définitif non envoyé (WhatsApp ${ctx.notifyJid}, ${ctx.job.targetDate}) : ${errorText(err)} — nouvel essai par le tick chaque minute.`,
      );
    } else {
      await logOnce(ctx, "send-failed", `Envoi du roster échoué : ${errorText(err)} — nouvel essai au prochain passage.`);
    }
    return "failed";
  }
  if (!sent.msgId) {
    // P1-11 : on ne repostera pas ce contenu, mais sans msgId on ne peut ni retirer l'ancien ni épingler.
    await setRosterFingerprint(db, fresh.id, fingerprint);
    await logOnce(ctx, "no-msg-id", "Roster envoyé sans msgId : ancien roster conservé, nouveau non épinglé.");
    return "published";
  }
  await setRosterMessage(db, fresh.id, { msgId: sent.msgId, jid: ctx.notifyJid, sentAt: ctx.now, fingerprint });
  const orphaned = await retireRoster(ctx, fresh, false);
  // Au plus un roster épinglé par job (C2-1) : un orphelin, ancien ou nouveau, bloque l'épinglage.
  if (ctx.pinEnabled && !fresh.rosterOrphan && !orphaned) await pinRoster(ctx, ctx.notifyJid, sent.msgId);
  return "published";
}

/** Publie `text` comme roster courant du job, en retirant l'ancien. `"busy"` : le tick rattrape. */
export async function publishRoster(ctx: RosterPublishContext, text: string, phase: RosterPhase): Promise<PublishOutcome> {
  const fingerprint = rosterFingerprint(text);
  if (fingerprint === ctx.job.rosterFingerprint) return "unchanged";
  const outcome = await withRosterClaim(ctx, (fresh) => publishOnFreshRow(ctx, fresh, text, fingerprint, phase));
  return outcome ?? "busy";
}

/**
 * Retire le roster courant (suppression ou désépinglage) puis l'oublie. Avec `unpinOnly`
 * (sondage suivant), désépingle seulement et garde msgId et empreinte (P2-2) : `roster_pinned_at`
 * est remis à null dans tous les cas, l'orphelin éventuel porte la suite (PC3-4).
 * Renvoie false si le claim est pris (rien n'est fait).
 */
export async function withdrawRoster(ctx: RosterPublishContext, opts: { unpinOnly?: boolean } = {}): Promise<boolean> {
  const unpinOnly = opts.unpinOnly ?? false;
  const done = await withRosterClaim(ctx, async (fresh) => {
    await retireRoster(ctx, fresh, unpinOnly);
    if (unpinOnly) {
      await setRosterPinnedAt(ctx.deps.db, fresh.id, null);
    } else {
      await setRosterMessage(ctx.deps.db, fresh.id, null);
    }
    return true;
  });
  return done ?? false;
}

/**
 * Passe des orphelins (tick), entièrement sous claim et sur la ligne fraîche : un orphelin expiré
 * est oublié sans appel huddle-bot, sinon on retente son désépinglage. Oublié (expiré ou
 * désépinglé), l'épinglage normal reprend sur le roster courant s'il n'est pas lui-même l'orphelin
 * (spec §4.7, C3-2, PC2-7). Claim occupé : l'orphelin reste en base, le tick suivant retente.
 */
export async function retryOrphanUnpin(ctx: RosterPublishContext): Promise<void> {
  if (!ctx.job.rosterOrphan) return;
  await withRosterClaim(ctx, async (fresh) => {
    const orphan = fresh.rosterOrphan;
    if (!orphan) return;
    const { db, huddleBot } = ctx.deps;
    if (new Date(orphan.expiresAt).getTime() > ctx.now.getTime()) {
      try {
        await unpinMessage(huddleBot.client, orphan.jid, orphan.msgId);
      } catch (err) {
        await logOnce(
          ctx,
          "orphan-retry-failed",
          `Désépinglage de l'ancien roster (${orphan.msgId}) toujours en échec : ${errorText(err)}`,
        );
        return;
      }
    }
    await setRosterOrphan(db, fresh.id, null);
    const { rosterMsgId, rosterJid } = fresh;
    if (!ctx.pinEnabled || !rosterMsgId || !rosterJid || rosterMsgId === orphan.msgId) return;
    if (fresh.rosterPinnedAt || fresh.rosterStoppedAt || fresh.cancelledAt) return;
    await pinRoster(ctx, rosterJid, rosterMsgId);
  });
}
