import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { loadEnv } from "./config.js";
import { loadBookingRules } from "./bookingRules.js";
import { createDbClient } from "@squash-assistant/db/client";
import { buildPipelineGraph } from "./graph/buildGraph.js";
import { startHttpServer } from "./http/server.js";
import { connectHuddleBot } from "./mcp/huddleBot.js";
import { connectResaSquash } from "./mcp/resaSquash.js";
import { recoverPendingGoWaits, scheduleBookingRules } from "./scheduler/scheduler.js";
import { sendTelegramMessage } from "./telegram/telegram.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env.databaseUrl);
  const rules = await loadBookingRules(db);
  const telegram = { botToken: env.telegramBotToken, chatId: env.telegramChatId };
  installUnhandledRejectionHandler(telegram);

  const huddleBot = await connectHuddleBot(env.huddleBotMcpUrl, env.huddleBotMcpApiKey);
  const resaSquash = await connectResaSquash(env.resaSquashMcpUrl, env.resaSquashMcpApiKey);
  const checkpointer = await RedisSaver.fromUrl(env.redisUrl);

  console.log("[squash-assistant] Connecté à huddle-bot, resa-squash, Redis et Postgres.");

  const graph = buildPipelineGraph({ huddleBot, resaSquash, telegram, db }, checkpointer);

  await recoverPendingGoWaits(rules, graph, telegram, db);
  scheduleBookingRules(rules, graph, telegram, db, huddleBot, resaSquash);
  startHttpServer({ db, graph, telegram, huddleBot, resaSquash });

  const activeRuleIds = rules.filter((r) => r.enabled).map((r) => r.id);
  console.log(
    activeRuleIds.length > 0
      ? `[squash-assistant] scheduler démarré pour : ${activeRuleIds.join(", ")}`
      : "[squash-assistant] scheduler démarré — aucune règle active (enabled: true) en base.",
  );

  const shutdown = async () => {
    console.log("[squash-assistant] arrêt en cours...");
    await huddleBot.close();
    await resaSquash.close();
    await checkpointer.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/**
 * Filet de sécurité : plusieurs chemins sont « fire-and-forget » (attente du
 * « go » Telegram, reprise après plan). Sans ce handler, une rejection non
 * gérée fait tomber le process (Node ≥ 15) et redémarre le pod ; on préfère
 * garder le scheduler en vie, tracer et alerter — le job concerné reste
 * relançable à la main depuis l'UI.
 */
function installUnhandledRejectionHandler(telegram: { botToken: string; chatId: string }): void {
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error("[squash-assistant] rejection non gérée :", message);
    void sendTelegramMessage(telegram, `⚠️ Worker : rejection non gérée — ${message.split("\n")[0]}`).catch(
      (err) => console.error("[squash-assistant] alerte Telegram impossible :", err),
    );
  });
}

main().catch((err) => {
  console.error("[squash-assistant] erreur fatale au démarrage :", err);
  process.exit(1);
});
