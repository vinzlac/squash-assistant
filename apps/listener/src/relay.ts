import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { formatRelayMessage, FormatRelayError } from "./format.js";
import type { WhatsAppActor, WhatsAppEvent } from "./whatsappEvents.js";

export interface RelayDeps {
  client: Client;
  vincentAllGroupJid: string;
  resolveActorName: (actor: WhatsAppActor) => Promise<string>;
  sendMessage: (client: Client, jid: string, text: string) => Promise<void>;
}

export async function relayToVincentAll(deps: RelayDeps, event: WhatsAppEvent): Promise<void> {
  const actorName = await deps.resolveActorName(event.actor);
  let text: string;
  try {
    text = formatRelayMessage(event, actorName);
  } catch (err) {
    throw new FormatRelayError(err);
  }
  await deps.sendMessage(deps.client, deps.vincentAllGroupJid, text);
}
