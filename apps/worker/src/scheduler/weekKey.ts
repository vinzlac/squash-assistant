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

/**
 * Bornes UTC [début, fin) d'une date calendaire Europe/Paris (ex. "2026-08-11") — même
 * heuristique de fuseau que slotStartDateIsoHeuristicParis (planning/teamrTime.ts) : +02:00
 * avril-octobre, +01:00 sinon (DST imparfait mars/novembre, accepté ailleurs dans le repo).
 */
export function parisCalendarDayBoundsUtc(dateStr: string): { start: Date; end: Date } {
  const month = Number(dateStr.slice(5, 7));
  const offset = month >= 4 && month <= 10 ? "+02:00" : "+01:00";
  const start = new Date(`${dateStr}T00:00:00${offset}`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** Clé stable (lundi de la semaine ISO) utilisée comme partie du thread_id LangGraph. */
export function computeWeekKey(triggerDate: Date): string {
  const date = parisCalendarDate(triggerDate);
  const isoWeekday = (date.getUTCDay() + 6) % 7; // 0 = lundi ... 6 = dimanche
  date.setUTCDate(date.getUTCDate() - isoWeekday);
  return date.toISOString().slice(0, 10);
}
