import { eq } from "drizzle-orm";
import { appSettings, playerPreferences, type PlayerPreference } from "@squash-assistant/db/schema";
import { getDb } from "./db";

const SETTINGS_ID = "singleton";

export interface PlaySlotsDefaults {
  defaultMinPlaySlots: number;
  defaultMaxPlaySlots: number;
}

export async function getPlaySlotsDefaults(): Promise<PlaySlotsDefaults> {
  const [row] = await getDb().select().from(appSettings).where(eq(appSettings.id, SETTINGS_ID));
  return {
    defaultMinPlaySlots: row?.defaultMinPlaySlots ?? 2,
    defaultMaxPlaySlots: row?.defaultMaxPlaySlots ?? 2,
  };
}

export async function setPlaySlotsDefaults(defaults: PlaySlotsDefaults): Promise<void> {
  const min = clampSlots(defaults.defaultMinPlaySlots);
  const max = Math.max(min, clampSlots(defaults.defaultMaxPlaySlots));
  await getDb()
    .insert(appSettings)
    .values({
      id: SETTINGS_ID,
      defaultMinPlaySlots: min,
      defaultMaxPlaySlots: max,
    })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { defaultMinPlaySlots: min, defaultMaxPlaySlots: max },
    });
}

export async function listPlayerPreferences(): Promise<PlayerPreference[]> {
  return getDb().select().from(playerPreferences);
}

export async function upsertPlayerPreference(input: {
  userId: string;
  displayName: string | null;
  minPlaySlots: number;
  maxPlaySlots: number;
}): Promise<void> {
  const min = clampSlots(input.minPlaySlots);
  const max = Math.max(min, clampSlots(input.maxPlaySlots));
  await getDb()
    .insert(playerPreferences)
    .values({
      userId: input.userId,
      displayName: input.displayName,
      minPlaySlots: min,
      maxPlaySlots: max,
    })
    .onConflictDoUpdate({
      target: playerPreferences.userId,
      set: {
        displayName: input.displayName,
        minPlaySlots: min,
        maxPlaySlots: max,
      },
    });
}

export async function deletePlayerPreference(userId: string): Promise<void> {
  await getDb().delete(playerPreferences).where(eq(playerPreferences.userId, userId));
}

function clampSlots(n: number): number {
  return Math.min(6, Math.max(1, Math.floor(n)));
}
