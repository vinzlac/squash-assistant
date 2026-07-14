import type { Database } from "@squash-assistant/db/client";
import type { McpConnection } from "../mcp/client.js";
import type { TelegramConfig } from "../telegram/telegram.js";

export interface GraphDependencies {
  huddleBot: McpConnection;
  resaSquash: McpConnection;
  telegram: TelegramConfig;
  db: Database;
}
