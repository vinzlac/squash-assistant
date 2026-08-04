import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { formatRelayMessage } from "./format.js";
import type { WhatsAppEvent } from "./whatsappEvents.js";

export interface RelayDeps {
  client: Client;
  vincentAllGroupJid: string;
  sendMessage: (client: Client, jid: string, text: string) => Promise<void>;
}

export async function relayToVincentAll(deps: RelayDeps, event: WhatsAppEvent): Promise<void> {
  const text = formatRelayMessage(event);
  await deps.sendMessage(deps.client, deps.vincentAllGroupJid, text);
}
