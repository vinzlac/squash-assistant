import { eq } from "drizzle-orm";
import { appSettings } from "@squash-assistant/db/schema";
import { getDb } from "./db";
import { SCHEDULE_DEFAULTS_FALLBACK, validateScheduleDefaults, type ScheduleDefaults } from "./scheduleDefaults";

const SETTINGS_ID = "singleton";

export async function getScheduleDefaults(): Promise<ScheduleDefaults> {
  const [row] = await getDb().select().from(appSettings).where(eq(appSettings.id, SETTINGS_ID));
  return {
    defaultPollDaysBefore: row?.defaultPollDaysBefore ?? SCHEDULE_DEFAULTS_FALLBACK.defaultPollDaysBefore,
    defaultPollTime: row?.defaultPollTime ?? SCHEDULE_DEFAULTS_FALLBACK.defaultPollTime,
    defaultDecisionDaysBefore: row?.defaultDecisionDaysBefore ?? SCHEDULE_DEFAULTS_FALLBACK.defaultDecisionDaysBefore,
    defaultDecisionTime: row?.defaultDecisionTime ?? SCHEDULE_DEFAULTS_FALLBACK.defaultDecisionTime,
  };
}

export async function setScheduleDefaults(defaults: ScheduleDefaults): Promise<void> {
  const errors = validateScheduleDefaults(defaults);
  if (errors.length > 0) {
    throw new Error(`Défauts de planification invalides : ${errors.join(" ")}`);
  }
  await getDb()
    .insert(appSettings)
    .values({ id: SETTINGS_ID, ...defaults })
    .onConflictDoUpdate({ target: appSettings.id, set: defaults });
}
