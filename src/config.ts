export interface GroupConfig {
  id: string;
  enabled: boolean;
  whatsappGroupJid: string;
  resaSquashGroupId: string;
  pollCron: string;
  decisionCron: string;
  targetWeekdayOffset: number;
  slotStartTimes: { court: number; beginTime: string }[];
}

export interface Env {
  huddleBotMcpUrl: string;
  huddleBotMcpApiKey: string;
  resaSquashMcpUrl: string;
  resaSquashMcpApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  redisUrl: string;
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
  };
}
