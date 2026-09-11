import { DISPLAY_TIMEZONE } from "./datetime";

const TIMEZONE = DISPLAY_TIMEZONE;

/**
 * Réplique volontairement apps/worker/src/graph/nodes/pollQuestion.ts (fonction
 * pure, ~10 lignes ; évite une dépendance au worker pour un calcul aussi simple)
 * — doit rester identique.
 */
function formatSessionTime(sessionStartTime: string): string {
  const match = /^(\d{1,2})H(\d{2})$/i.exec(sessionStartTime);
  if (!match) {
    return sessionStartTime;
  }
  const [, hour, minutes] = match;
  return minutes === "00" ? `${hour}h` : `${hour}h${minutes}`;
}

function formatSessionTimeList(candidateStartTimes: string[]): string {
  const formatted = candidateStartTimes.map(formatSessionTime);
  if (formatted.length <= 1) return formatted[0] ?? "";
  return `${formatted.slice(0, -1).join(", ")} ou ${formatted[formatted.length - 1]}`;
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

export function buildPollQuestionPreview(targetDate: string, candidateStartTimes: string[]): string {
  const timeLabel = formatSessionTimeList(candidateStartTimes);
  return candidateStartTimes.length > 1
    ? `Squash ${formatInformalDate(targetDate)}, à quelle heure : ${timeLabel} ?`
    : `Squash ${formatInformalDate(targetDate)} à ${timeLabel} ?`;
}
