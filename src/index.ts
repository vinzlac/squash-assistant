import { loadEnv } from "./config.js";
import { createRedisClient } from "./redis.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const redis = createRedisClient(env.redisUrl);

  await redis.connect();
  console.log("[squash-assistant] Redis connecté :", env.redisUrl);

  // TODO Phase 2 (docs/plan/squash-assistant-poc.md §3, §7) : StateGraph LangGraph
  // (SendPoll → CollectVotes → BookSlots → Announce) + scheduler node-cron par groupe.
  console.log("[squash-assistant] démarré — scheduler pas encore implémenté (Phase 2)");

  const shutdown = async () => {
    console.log("[squash-assistant] arrêt en cours...");
    await redis.quit();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[squash-assistant] erreur fatale au démarrage :", err);
  process.exit(1);
});
