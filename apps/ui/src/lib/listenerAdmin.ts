import { desc, eq } from "drizzle-orm";
import { listenerRelaySettings, whatsappResaEvents } from "@squash-assistant/db/schema";
import { getDb } from "./db";

const DEFAULT_SETTINGS_ID = "default";

export type RelaySettings = typeof listenerRelaySettings.$inferSelect;

export type RelaySettingsUpdate = Partial<
  Pick<
    RelaySettings,
    "pollCreation" | "pollVoteCreation" | "pollVoteUpdate" | "pollVoteDeletion"
  >
>;

export async function listResaEvents({ limit, offset }: { limit: number; offset: number }) {
  return getDb()
    .select()
    .from(whatsappResaEvents)
    .orderBy(desc(whatsappResaEvents.occurredAt))
    .limit(limit)
    .offset(offset);
}

export async function getRelaySettings(): Promise<RelaySettings> {
  const db = getDb();
  await db.insert(listenerRelaySettings).values({ id: DEFAULT_SETTINGS_ID }).onConflictDoNothing();

  const [row] = await db
    .select()
    .from(listenerRelaySettings)
    .where(eq(listenerRelaySettings.id, DEFAULT_SETTINGS_ID))
    .limit(1);

  if (!row) {
    throw new Error("listener_relay_settings default row missing");
  }
  return row;
}

export async function updateRelaySettings(partial: RelaySettingsUpdate): Promise<void> {
  await getDb()
    .update(listenerRelaySettings)
    .set({ ...partial, updatedAt: new Date() })
    .where(eq(listenerRelaySettings.id, DEFAULT_SETTINGS_ID));
}
