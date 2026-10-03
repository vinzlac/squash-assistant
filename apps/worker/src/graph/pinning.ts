import { pinMessage, unpinMessage, type PinDuration } from "../mcp/huddleBot.js";
import { sendTelegramMessage } from "../telegram/telegram.js";
import type { GraphDependencies } from "./dependencies.js";

// Sondage et annonce sont désépinglés explicitement bien avant (collecte / sondage suivant,
// hebdomadaire) : l'expiration WhatsApp n'est qu'un filet si la règle s'arrête.
const PIN_DURATION: PinDuration = "7d";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort : un échec d'épinglage ne doit jamais faire échouer une étape du pipeline. */
export async function pinBestEffort(
  deps: GraphDependencies,
  ruleLabel: string,
  jid: string,
  msgId: string,
  what: string,
): Promise<void> {
  try {
    await pinMessage(deps.huddleBot.client, jid, msgId, PIN_DURATION);
  } catch (err) {
    await sendTelegramMessage(deps.telegram, `[${ruleLabel}] Épinglage ${what} échoué : ${errorText(err)}`).catch(
      () => {},
    );
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
