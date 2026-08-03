import { eq } from "drizzle-orm";
import { appSettings } from "@squash-assistant/db/schema";
import { getDb } from "./db";

const SETTINGS_ID = "singleton";

/** null = jamais configuré (afficher tous les groupes WhatsApp) — voir schema.ts. */
export async function getVisibleWhatsappGroupJids(): Promise<string[] | null> {
  const [row] = await getDb().select().from(appSettings).where(eq(appSettings.id, SETTINGS_ID));
  return row?.visibleWhatsappGroupJids ?? null;
}

export async function setVisibleWhatsappGroupJids(jids: string[]): Promise<void> {
  await getDb()
    .insert(appSettings)
    .values({ id: SETTINGS_ID, visibleWhatsappGroupJids: jids })
    .onConflictDoUpdate({ target: appSettings.id, set: { visibleWhatsappGroupJids: jids } });
}
