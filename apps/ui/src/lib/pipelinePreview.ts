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

/** Doit rester identique au template utilisé dans apps/worker/src/graph/nodes/sendPoll.ts. */
export function buildPollQuestionPreview(targetDate: string, sessionStartTime: string): string {
  return `Qui joue le ${targetDate} à ${sessionStartTime} ?`;
}
