import { eq } from "drizzle-orm";
import type { Database } from "@squash-assistant/db/client";
import { listenerRelaySettings } from "@squash-assistant/db/schema";
import { WhatsAppEventType } from "./whatsappEvents.js";

export type ListenerRelaySettings = typeof listenerRelaySettings.$inferSelect;

const DEFAULT_ID = "default";

export async function ensureDefaultRow(db: Database): Promise<void> {
  await db.insert(listenerRelaySettings).values({ id: DEFAULT_ID }).onConflictDoNothing();
}

export async function loadListenerRelaySettings(db: Database): Promise<ListenerRelaySettings> {
  const rows = await db
    .select()
    .from(listenerRelaySettings)
    .where(eq(listenerRelaySettings.id, DEFAULT_ID))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error("listener_relay_settings default row missing");
  }
  return row;
}

export function isRelayTypeEnabled(settings: ListenerRelaySettings, eventType: string): boolean {
  switch (eventType) {
    case WhatsAppEventType.PollCreation:
      return settings.pollCreation;
    case WhatsAppEventType.PollVoteCreation:
      return settings.pollVoteCreation;
    case WhatsAppEventType.PollVoteUpdate:
      return settings.pollVoteUpdate;
    case WhatsAppEventType.PollVoteDeletion:
      return settings.pollVoteDeletion;
    default:
      return false;
  }
}
