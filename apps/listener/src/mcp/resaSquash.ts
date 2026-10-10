import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callTool, connectMcpClient, type McpConnection } from "./client.js";
import type { PlayerNameParts } from "@squash-assistant/db/playerLabel";

export interface PlayerLookup extends PlayerNameParts {
  found: boolean;
  userId?: string;
}

export function connectResaSquash(url: string, apiKey: string): Promise<McpConnection> {
  return connectMcpClient("resa-squash-listener", url, apiKey);
}

export function lookupPlayerByPhone(client: Client, phone: string): Promise<PlayerLookup> {
  return callTool(client, "lookup_player_by_phone", { phone });
}
