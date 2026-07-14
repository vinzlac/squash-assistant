// BookingRule vit dans @squash-assistant/db (co-localisé avec le schéma Drizzle
// dont il dérive) — réexporté ici pour ne pas casser les imports existants.
export type { BookingRule } from "@squash-assistant/db/schema";

export interface Env {
  huddleBotMcpUrl: string;
  huddleBotMcpApiKey: string;
  resaSquashMcpUrl: string;
  resaSquashMcpApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  redisUrl: string;
  databaseUrl: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

export function loadEnv(): Env {
  return {
    huddleBotMcpUrl: requireEnv("HUDDLE_BOT_MCP_URL"),
    huddleBotMcpApiKey: requireEnv("HUDDLE_BOT_MCP_API_KEY"),
    resaSquashMcpUrl: requireEnv("RESA_SQUASH_MCP_URL"),
    resaSquashMcpApiKey: requireEnv("RESA_SQUASH_MCP_API_KEY"),
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    telegramChatId: requireEnv("TELEGRAM_CHAT_ID"),
    redisUrl: requireEnv("REDIS_URL"),
    databaseUrl: requireEnv("DATABASE_URL"),
  };
}
