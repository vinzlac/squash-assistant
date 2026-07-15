import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callTool, connectMcpClient, type McpConnection } from "./client.js";

export interface HuddleBotGroup {
  jid: string;
  name: string;
  isGroup: boolean;
  lastMessage: string;
  lastMessageTimestamp: number;
  unreadCount: number;
}

export type PollResponseStatus = "oui" | "non" | "ambigu" | "aucune_reponse";

export interface PollResponses {
  requestId: string;
  type: "poll" | "question";
  responses: Array<{ member: string; phone: string | null; statut: PollResponseStatus }>;
  /** msgId WhatsApp du sondage (pour delete_message) — absent pour ask_question. */
  msgId?: string;
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
): Promise<{ requestId: string; msgId?: string }> {
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

/**
 * Ne peut pas être utilisé pour annuler un sondage envoyé par erreur :
 * ask_poll/get_responses ne renvoient jamais le msgId WhatsApp du sondage
 * (huddle-bot le stocke en interne — pollMsgKey — mais ne l'expose pas via
 * l'API MCP). Utile en revanche pour supprimer un message texte simple
 * (ex. send_message) dont on connaît déjà le msgId par un autre biais.
 */
export function deleteMessage(client: Client, jid: string, msgId: string): Promise<void> {
  return callTool(client, "delete_message", { jid, msgId });
}

/** Ne fonctionne pas sur un sondage (ask_poll) — messages texte uniquement, côté huddle-bot. */
export function editMessage(client: Client, jid: string, msgId: string, text: string): Promise<void> {
  return callTool(client, "edit_message", { jid, msgId, text });
}
