/**
 * Une règle de réservation associe un groupe WhatsApp à un groupe resa-squash
 * pour un créneau récurrent donné. Un même groupe WhatsApp peut avoir
 * plusieurs règles (ex. squashacadémie mardi + squashacadémie jeudi).
 *
 * Seuls maxReservationsPerPlayer (→ slotsPerPlayer) et priorityBookers
 * (→ ordre de expectedPlayerIds) ont un équivalent direct côté
 * plan_group_bookings (MCP resa-squash, vérifié via listTools() en Phase 1).
 * maxCourtsPerSlot, minPlayersPerCourt, maxPlayersPerCourt,
 * preferMinPlayersPerCourt et courtPriority sont stockés mais pas encore
 * branchés à un appel MCP — aucun paramètre équivalent n'existe aujourd'hui
 * côté resa-squash (à revisiter si le tool évolue, ou si squash-assistant
 * doit un jour construire sa propre couche d'allocation).
 */
export interface BookingRule {
  id: string;
  enabled: boolean;
  whatsappGroupJid: string;
  resaSquashGroupId: string;
  pollCron: string;
  decisionCron: string;
  targetWeekdayOffset: number;
  sessionStartTime: string;
  maxCourtsPerSlot: number;
  minPlayersPerCourt: number;
  maxPlayersPerCourt: number;
  maxReservationsPerPlayer: number;
  priorityBookers: string[];
  preferMinPlayersPerCourt: boolean;
  courtPriority: number[];
}

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
