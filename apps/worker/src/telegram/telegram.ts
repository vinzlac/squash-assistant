const TELEGRAM_API_BASE = "https://api.telegram.org";
const GO_CONFIRMATION_TEXT = "go";
const LONG_POLL_TIMEOUT_SECONDS = 30;

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: number | string } };
}

export async function sendTelegramMessage(config: TelegramConfig, text: string): Promise<void> {
  const url = `${TELEGRAM_API_BASE}/bot${config.botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, text }),
  });
  if (!response.ok) {
    throw new Error(`Envoi Telegram échoué (${response.status}) : ${await response.text()}`);
  }
}

/**
 * Décalage (update_id + 1) du dernier message Telegram déjà traité, partagé
 * entre tous les appels de waitForGoConfirmation dans la durée de vie du
 * process — sans lui, chaque nouvel appel repartait sans offset (`undefined`)
 * et Telegram rejouait tout le backlog non acquitté, y compris un "go" déjà
 * utilisé pour un job précédent : ce "go" périmé résolvait alors
 * instantanément un job sans rapport, encore en attente. Persister l'offset
 * au fil de l'eau (pas seulement à la sortie de la boucle) garantit qu'un
 * message n'est jamais rejoué, qu'il ait matché "go" ou non.
 */
let lastProcessedOffset: number | undefined;

export async function waitForGoConfirmation(
  config: TelegramConfig,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const deadline = options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;

  while (!deadline || Date.now() < deadline) {
    const updates = await getTelegramUpdates(config.botToken, lastProcessedOffset);
    for (const update of updates) {
      lastProcessedOffset = update.update_id + 1;
      const text = update.message?.text?.trim().toLowerCase();
      const fromExpectedChat = String(update.message?.chat.id) === String(config.chatId);
      if (fromExpectedChat && text === GO_CONFIRMATION_TEXT) {
        return true;
      }
    }
  }
  return false;
}

async function getTelegramUpdates(botToken: string, offset?: number): Promise<TelegramUpdate[]> {
  const url = new URL(`${TELEGRAM_API_BASE}/bot${botToken}/getUpdates`);
  url.searchParams.set("timeout", String(LONG_POLL_TIMEOUT_SECONDS));
  if (offset !== undefined) {
    url.searchParams.set("offset", String(offset));
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`getUpdates Telegram échoué (${response.status}) : ${await response.text()}`);
  }
  const body = (await response.json()) as { ok: boolean; result: TelegramUpdate[] };
  return body.result;
}
