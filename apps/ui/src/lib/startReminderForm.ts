export const START_REMINDER_MIN_MINUTES = 30;
export const START_REMINDER_MAX_MINUTES = 360;
export const START_REMINDER_DEFAULT_MINUTES = 120;

/** Délai du rappel avant le match (minutes) lu dans le formulaire de règle — refuse hors bornes au lieu de corriger. */
export function parseStartReminderMinutes(formData: FormData): number {
  const raw = String(formData.get("startReminderMinutesBefore") ?? "").trim();
  if (raw === "") return START_REMINDER_DEFAULT_MINUTES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < START_REMINDER_MIN_MINUTES || value > START_REMINDER_MAX_MINUTES) {
    throw new Error(
      `Rappel avant le match : le délai doit être un nombre entier de minutes entre ${START_REMINDER_MIN_MINUTES} et ${START_REMINDER_MAX_MINUTES}.`,
    );
  }
  return value;
}
