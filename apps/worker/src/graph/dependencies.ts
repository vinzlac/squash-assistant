import type { Database } from "@squash-assistant/db/client";
import type { McpConnection } from "../mcp/client.js";
import type { TelegramConfig } from "../telegram/telegram.js";

export interface GraphDependencies {
  huddleBot: McpConnection;
  resaSquash: McpConnection;
  telegram: TelegramConfig;
  db: Database;
  /** Groupe WhatsApp de test : reçoit le détail « Non réservé » de l'annonce (absent = pas d'envoi). */
  testGroupJid?: string;
}
