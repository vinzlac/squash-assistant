import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callTool, connectMcpClient, type McpConnection } from "./client.js";

export interface HuddleBotGroup {
  jid: string;
  name: string;
}

export type PollResponseStatus = "oui" | "non" | "ambigu" | "aucune_reponse";

export interface PollResponses {
  requestId: string;
  responses: Array<{ jid: string; name: string; status: PollResponseStatus }>;
}

export function connectHuddleBot(url: string, apiKey: string): Promise<McpConnection> {
  return connectMcpClient("huddle-bot", url, apiKey);
}

export function listGroups(client: Client): Promise<{ groups: HuddleBotGroup[] }> {
  return callTool(client, "list_groups");
}

export function askPoll(
  client: Client,
  groupJid: string,
  question: string,
): Promise<{ requestId: string }> {
  return callTool(client, "ask_poll", { groupJid, question });
}

export function askQuestion(
  client: Client,
  groupJid: string,
  question: string,
): Promise<{ requestId: string }> {
  return callTool(client, "ask_question", { groupJid, question });
}

export function getResponses(client: Client, requestId: string): Promise<PollResponses> {
  return callTool(client, "get_responses", { requestId });
}

export function sendMessage(client: Client, jid: string, text: string): Promise<void> {
  return callTool(client, "send_message", { jid, text });
}
