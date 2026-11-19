const TELEGRAM_API_BASE = "https://api.telegram.org";
const GO_CONFIRMATION_TEXT = "go";
const LONG_POLL_TIMEOUT_SECONDS = 30;
/** Pause avant de réinterroger Telegram après un échec (réseau, 5xx, passerelle en redémarrage). */
const GET_UPDATES_RETRY_DELAY_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  /** Base de l'API Bot (défaut api.telegram.org), par exemple la passerelle telegram-gateway du homelab. */
  apiUrl?: string;
}

/**
 * `TELEGRAM_API_URL` facultative : absente ou vide → api.telegram.org ; sinon une URL http(s) sans
 * query, fragment ni identifiants (ils casseraient `${base}/bot<token>/<méthode>`), barre finale retirée.
 */
export function parseTelegramApiUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return TELEGRAM_API_BASE;
  let parsed: URL | null = null;
  try {
    parsed = new URL(value);
  } catch {
    parsed = null;
  }
  const malformed =
    parsed === null ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.hostname === "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== "";
  if (malformed) {
    throw new Error(`Variable d'environnement invalide : TELEGRAM_API_URL doit être une URL http(s) (reçu ${JSON.stringify(value)})`);
  }
  return value.replace(/\/+$/, "");
}

interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: number | string } };
}

export async function sendTelegramMessage(config: TelegramConfig, text: string): Promise<void> {
  const url = `${config.apiUrl ?? TELEGRAM_API_BASE}/bot${config.botToken}/sendMessage`;
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
  options: { timeoutMs?: number; retryDelayMs?: number } = {},
): Promise<boolean> {
  const deadline = options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
  const retryDelayMs = options.retryDelayMs ?? GET_UPDATES_RETRY_DELAY_MS;

  while (!deadline || Date.now() < deadline) {
    let updates: TelegramUpdate[];
    try {
      updates = await getTelegramUpdates(config, lastProcessedOffset);
    } catch (err) {
      // L'attente tourne sans await (fire-and-forget) : une erreur ici l'arrêterait jusqu'au
      // prochain redémarrage du worker, et un « go » de réservation réelle ne serait plus lu.
      // L'offset n'avance pas sur un échec : aucun message n'est sauté ni rejoué.
      console.warn(
        "[squash-assistant] getUpdates Telegram en échec, nouvel essai :",
        err instanceof Error ? err.message.split("\n")[0] : String(err),
      );
      await sleep(retryDelayMs);
      continue;
    }
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

async function getTelegramUpdates(config: TelegramConfig, offset?: number): Promise<TelegramUpdate[]> {
  const url = new URL(`${config.apiUrl ?? TELEGRAM_API_BASE}/bot${config.botToken}/getUpdates`);
  url.searchParams.set("timeout", String(LONG_POLL_TIMEOUT_SECONDS));
  if (offset !== undefined) {
    url.searchParams.set("offset", String(offset));
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`getUpdates Telegram échoué (${response.status}) : ${await response.text()}`);
  }
  const body = (await response.json()) as { ok?: boolean; result?: unknown };
  // Une réponse 200 sans liste d'updates ferait lever le `for...of` de l'appelant hors de sa reprise.
  if (!body?.ok || !Array.isArray(body.result)) {
    throw new Error("getUpdates Telegram : réponse inattendue (pas de liste d'updates)");
  }
  return body.result as TelegramUpdate[];
}
