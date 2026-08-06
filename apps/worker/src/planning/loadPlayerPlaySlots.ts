import { eq } from "drizzle-orm";
import { appSettings, playerPreferences } from "@squash-assistant/db/schema";
import type { Database } from "@squash-assistant/db/client";
import {
  DEFAULT_PLAY_SLOTS,
  type PlayerPlaySlots,
  type PlaySlotsDefaults,
} from "./playerPlaySlots.js";

const SETTINGS_ID = "singleton";

/** Charge défauts globaux + surcharges player_preferences (I/O DB). */
export async function loadPlaySlotsConfig(db: Database): Promise<{
  defaults: PlaySlotsDefaults;
  overrides: Map<string, PlayerPlaySlots>;
}> {
  const [settings] = await db.select().from(appSettings).where(eq(appSettings.id, SETTINGS_ID));
  const defaults: PlaySlotsDefaults = {
    defaultMinPlaySlots: settings?.defaultMinPlaySlots ?? DEFAULT_PLAY_SLOTS.defaultMinPlaySlots,
    defaultMaxPlaySlots: settings?.defaultMaxPlaySlots ?? DEFAULT_PLAY_SLOTS.defaultMaxPlaySlots,
  };

  const rows = await db.select().from(playerPreferences);
  const overrides = new Map<string, PlayerPlaySlots>();
  for (const row of rows) {
    overrides.set(row.userId, { minSlots: row.minPlaySlots, maxSlots: row.maxPlaySlots });
  }
  return { defaults, overrides };
}
