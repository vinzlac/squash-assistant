import { connect } from "@nats-io/transport-node";
import { jetstream } from "@nats-io/jetstream";
import { createDbClient } from "@squash-assistant/db/client";
import { loadEnv } from "./config.js";
import { loadAllowlist } from "./allowlist.js";
import { connectHuddleBot, sendMessage } from "./mcp/huddleBot.js";
import { relayToVincentAll } from "./relay.js";
import { onResaEvent } from "./onResaEvent.js";
import { handleJsMessage } from "./handleMessage.js";
import { startHealthServer } from "./health.js";

const STREAM = "WHATSAPP_EVENTS";
const CONSUMER = "squash-assistant-listener";

async function main(): Promise<void> {
  const env = loadEnv();
  startHealthServer(env.healthPort);

  const db = createDbClient(env.databaseUrl);
  let allowlist = await loadAllowlist(db, env.vincentAllGroupJid);
  setInterval(() => {
    loadAllowlist(db, env.vincentAllGroupJid)
      .then((next) => {
        allowlist = next;
      })
      .catch((err) => console.error("[listener] refresh allowlist échoué", err));
  }, env.allowlistRefreshMs);

  const mcp = await connectHuddleBot(env.huddleBotMcpUrl, env.huddleBotMcpApiKey);
  const nc = await connect({
    servers: env.natsUrl,
    user: env.natsUser,
    pass: env.natsPassword,
  });
  const js = jetstream(nc);
  const consumer = await js.consumers.get(STREAM, CONSUMER);
  const messages = await consumer.consume();

  console.log(`[listener] abonné stream=${STREAM} consumer=${CONSUMER} allowlist=${allowlist.size}`);

  for await (const msg of messages) {
    await handleJsMessage(msg, {
      allowlist,
      vincentAllGroupJid: env.vincentAllGroupJid,
      onResaEvent: (event) =>
        onResaEvent(
          {
            relay: (e) =>
              relayToVincentAll(
                { client: mcp.client, vincentAllGroupJid: env.vincentAllGroupJid, sendMessage },
                e,
              ),
          },
          event,
        ),
    });
  }
}

main().catch((err) => {
  console.error("[listener] échec fatal", err);
  process.exit(1);
});
