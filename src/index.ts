import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { loadEnv } from "./config.js";
import { loadGroupConfigs } from "./groupsConfig.js";
import { buildPipelineGraph } from "./graph/buildGraph.js";
import { connectHuddleBot } from "./mcp/huddleBot.js";
import { connectResaSquash } from "./mcp/resaSquash.js";
import { recoverPendingGoWaits, scheduleGroupPipelines } from "./scheduler/scheduler.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const groups = await loadGroupConfigs();
  const telegram = { botToken: env.telegramBotToken, chatId: env.telegramChatId };

  const huddleBot = await connectHuddleBot(env.huddleBotMcpUrl, env.huddleBotMcpApiKey);
  const resaSquash = await connectResaSquash(env.resaSquashMcpUrl, env.resaSquashMcpApiKey);
  const checkpointer = await RedisSaver.fromUrl(env.redisUrl);

  console.log("[squash-assistant] Connecté à huddle-bot, resa-squash et Redis.");

  const graph = buildPipelineGraph({ huddleBot, resaSquash, telegram }, checkpointer);

  await recoverPendingGoWaits(groups, graph, telegram);
  scheduleGroupPipelines(groups, graph, telegram);

  const activeGroupIds = groups.filter((g) => g.enabled).map((g) => g.id);
  console.log(
    activeGroupIds.length > 0
      ? `[squash-assistant] scheduler démarré pour : ${activeGroupIds.join(", ")}`
      : "[squash-assistant] scheduler démarré — aucun groupe actif (enabled: true) dans groups.json",
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

main().catch((err) => {
  console.error("[squash-assistant] erreur fatale au démarrage :", err);
  process.exit(1);
});
