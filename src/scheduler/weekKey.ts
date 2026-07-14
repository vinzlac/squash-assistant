/** Jour cible = déclenchement + targetWeekdayOffset (ex. mardi → mardi J+7, ou mardi → samedi J+4). */
export function computeTargetDate(triggerDate: Date, targetWeekdayOffset: number): string {
  const target = new Date(triggerDate);
  target.setDate(target.getDate() + targetWeekdayOffset);
  return target.toISOString().slice(0, 10);
}

/** Clé stable (lundi de la semaine ISO) utilisée comme partie du thread_id LangGraph. */
export function computeWeekKey(triggerDate: Date): string {
  const date = new Date(triggerDate);
  const isoWeekday = (date.getDay() + 6) % 7; // 0 = lundi ... 6 = dimanche
  date.setDate(date.getDate() - isoWeekday);
  return date.toISOString().slice(0, 10);
}
