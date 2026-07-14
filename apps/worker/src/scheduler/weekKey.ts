const TIMEZONE = "Europe/Paris";

/**
 * Convertit un instant en date calendaire Europe/Paris (minuit UTC de ce
 * jour-là), indépendamment du fuseau système de l'hôte — sinon getDay()/
 * setDate() raisonnent dans le fuseau du pod, qui peut différer du fuseau
 * du cron (toujours Europe/Paris, cf. scheduler.ts).
 */
function parisCalendarDate(instant: Date): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  return new Date(`${ymd}T00:00:00Z`);
}

/** Jour cible = déclenchement + targetWeekdayOffset (ex. mardi → mardi J+7, ou mardi → samedi J+4). */
export function computeTargetDate(triggerDate: Date, targetWeekdayOffset: number): string {
  const target = parisCalendarDate(triggerDate);
  target.setUTCDate(target.getUTCDate() + targetWeekdayOffset);
  return target.toISOString().slice(0, 10);
}

/** Clé stable (lundi de la semaine ISO) utilisée comme partie du thread_id LangGraph. */
export function computeWeekKey(triggerDate: Date): string {
  const date = parisCalendarDate(triggerDate);
  const isoWeekday = (date.getUTCDay() + 6) % 7; // 0 = lundi ... 6 = dimanche
  date.setUTCDate(date.getUTCDate() - isoWeekday);
  return date.toISOString().slice(0, 10);
}
