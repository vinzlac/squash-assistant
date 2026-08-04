import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { formatRelayMessage, FormatRelayError } from "./format.js";
import type { WhatsAppEvent } from "./whatsappEvents.js";

export interface RelayDeps {
  client: Client;
  vincentAllGroupJid: string;
  sendMessage: (client: Client, jid: string, text: string) => Promise<void>;
}

export async function relayToVincentAll(deps: RelayDeps, event: WhatsAppEvent): Promise<void> {
  let text: string;
  try {
    text = formatRelayMessage(event);
  } catch (err) {
    throw new FormatRelayError(err);
  }
  await deps.sendMessage(deps.client, deps.vincentAllGroupJid, text);
}
