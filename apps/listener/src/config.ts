export interface ListenerEnv {
  natsUrl: string;
  natsUser: string;
  natsPassword: string;
  vincentAllGroupJid: string;
  huddleBotMcpUrl: string;
  huddleBotMcpApiKey: string;
  databaseUrl: string;
  allowlistRefreshMs: number;
  healthPort: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante : ${name}`);
  return value;
}

export function loadEnv(): ListenerEnv {
  return {
    natsUrl: requireEnv("NATS_URL"),
    natsUser: requireEnv("NATS_USER"),
    natsPassword: requireEnv("NATS_PASSWORD"),
    vincentAllGroupJid: requireEnv("VINCENT_ALL_GROUP_JID"),
    huddleBotMcpUrl: requireEnv("HUDDLE_BOT_MCP_URL"),
    huddleBotMcpApiKey: requireEnv("HUDDLE_BOT_MCP_API_KEY"),
    databaseUrl: requireEnv("DATABASE_URL"),
    allowlistRefreshMs: Number(process.env.ALLOWLIST_REFRESH_MS ?? "60000"),
    healthPort: Number(process.env.HEALTH_PORT ?? "8081"),
  };
}
