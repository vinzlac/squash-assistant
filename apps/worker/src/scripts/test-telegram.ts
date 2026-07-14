import { loadEnv } from "../config.js";
import { sendTelegramMessage, waitForGoConfirmation } from "../telegram/telegram.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const config = { botToken: env.telegramBotToken, chatId: env.telegramChatId };

  await sendTelegramMessage(
    config,
    "[squash-assistant] Test Phase 1 : réponds \"go\" dans ce chat pour valider le long-polling.",
  );
  console.log("[test-telegram] Message de test envoyé. En attente d'un \"go\" (2 min max)...");

  const confirmed = await waitForGoConfirmation(config, { timeoutMs: 2 * 60 * 1000 });
  console.log(confirmed ? "[test-telegram] \"go\" reçu ✅" : "[test-telegram] Timeout sans confirmation ❌");
}

main().catch((err) => {
  console.error("[test-telegram] erreur :", err);
  process.exit(1);
});
