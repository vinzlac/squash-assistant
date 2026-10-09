import type { JobRun } from "@squash-assistant/db/schema";
import { setJobRunRecapInfo } from "../jobRuns.js";
import { pinMessage, unpinMessage, type PinDuration } from "../mcp/huddleBot.js";
import { sendTelegramMessage } from "../telegram/telegram.js";
import type { GraphDependencies } from "./dependencies.js";

// Sondage et annonce sont désépinglés explicitement bien avant (collecte / sondage suivant,
// hebdomadaire) : l'expiration WhatsApp n'est qu'un filet si la règle s'arrête.
const PIN_DURATION: PinDuration = "7d";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort : un échec d'épinglage ne doit jamais faire échouer une étape du pipeline. Renvoie true si épinglé. */
export async function pinBestEffort(
  deps: GraphDependencies,
  ruleLabel: string,
  jid: string,
  msgId: string,
  what: string,
): Promise<boolean> {
  try {
    await pinMessage(deps.huddleBot.client, jid, msgId, PIN_DURATION);
    return true;
  } catch (err) {
    await sendTelegramMessage(deps.telegram, `[${ruleLabel}] Épinglage ${what} échoué : ${errorText(err)}`).catch(
      () => {},
    );
    return false;
  }
}

export async function unpinBestEffort(
  deps: GraphDependencies,
  ruleLabel: string,
  jid: string,
  msgId: string,
  what: string,
): Promise<boolean> {
  try {
    await unpinMessage(deps.huddleBot.client, jid, msgId);
    return true;
  } catch (err) {
    await sendTelegramMessage(deps.telegram, `[${ruleLabel}] Désépinglage ${what} échoué : ${errorText(err)}`).catch(
      () => {},
    );
    return false;
  }
}

/**
 * Désépingle tout de suite le récap des inscrits d'un job (annulation : fermeture PUC, annulation
 * manuelle). Oublié seulement si le désépinglage a réussi ; sinon le tick à la minute réessaie.
 * Ne lève jamais : l'annulation doit aller au bout.
 */
export async function unpinRecapNow(
  deps: GraphDependencies,
  ruleLabel: string,
  job: Pick<JobRun, "id" | "recapMsgId" | "recapJid">,
): Promise<void> {
  if (!job.recapMsgId || !job.recapJid) return;
  const unpinned = await unpinBestEffort(deps, ruleLabel, job.recapJid, job.recapMsgId, "du récap");
  if (!unpinned) return;
  await setJobRunRecapInfo(deps.db, job.id, null).catch((err) => {
    console.error(`[pinning] récap du job ${job.id} désépinglé mais non oublié :`, err);
  });
}
