const TIMEZONE = "Europe/Paris";

/**
 * Réplique volontairement apps/worker/src/scheduler/weekKey.ts#computeTargetDate
 * (fonction pure, ~10 lignes) — juste pour l'aperçu affiché avant de lancer le
 * sondage, sans dépendre du worker pour un calcul aussi simple.
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

export function computeTargetDate(triggerDate: Date, targetWeekdayOffset: number): string {
  const target = parisCalendarDate(triggerDate);
  target.setUTCDate(target.getUTCDate() + targetWeekdayOffset);
  return target.toISOString().slice(0, 10);
}

/**
 * Réplique volontairement apps/worker/src/graph/nodes/pollQuestion.ts (mêmes
 * raisons que parisCalendarDate ci-dessus) — doit rester identique.
 */
function formatSessionTime(sessionStartTime: string): string {
  const match = /^(\d{1,2})H(\d{2})$/i.exec(sessionStartTime);
  if (!match) {
    return sessionStartTime;
  }
  const [, hour, minutes] = match;
  return minutes === "00" ? `${hour}h` : `${hour}h${minutes}`;
}

function formatInformalDate(targetDate: string): string {
  const date = new Date(`${targetDate}T00:00:00Z`);
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

export function buildPollQuestionPreview(targetDate: string, sessionStartTime: string): string {
  return `Squash ${formatInformalDate(targetDate)} à ${formatSessionTime(sessionStartTime)} ?`;
}
