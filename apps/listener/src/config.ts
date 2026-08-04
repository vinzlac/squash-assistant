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

function requirePositiveInt(name: string, raw: string | undefined, defaultValue: string): number {
  const str = raw ?? defaultValue;
  const value = Number(str);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Variable d'environnement invalide : ${name} (entier positif attendu, reçu « ${str} »)`);
  }
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
    allowlistRefreshMs: requirePositiveInt("ALLOWLIST_REFRESH_MS", process.env.ALLOWLIST_REFRESH_MS, "60000"),
    healthPort: requirePositiveInt("HEALTH_PORT", process.env.HEALTH_PORT, "8081"),
  };
}
