import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callTool, connectMcpClient, type McpConnection } from "./client.js";

export function connectHuddleBot(url: string, apiKey: string): Promise<McpConnection> {
  return connectMcpClient("huddle-bot-listener", url, apiKey);
}

export function sendMessage(client: Client, jid: string, text: string): Promise<void> {
  return callTool(client, "send_message", { jid, text });
}
