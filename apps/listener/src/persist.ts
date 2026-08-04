import type { Database } from "@squash-assistant/db/client";
import { whatsappResaEvents } from "@squash-assistant/db/schema";
import { formatRelayMessage } from "./format.js";
import type { WhatsAppEvent } from "./whatsappEvents.js";

export async function persistResaEvent(db: Database, event: WhatsAppEvent): Promise<void> {
  const summary = formatRelayMessage(event);
  await db
    .insert(whatsappResaEvents)
    .values({
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: new Date(event.occurredAt),
      chatJid: event.chat.jid,
      chatName: event.chat.name,
      actorPhone: event.actor.phone,
      actorName: event.actor.displayName,
      actorJid: event.actor.jid,
      summary,
      payload: event,
    })
    .onConflictDoNothing({ target: whatsappResaEvents.eventId });
}
