const TIMEZONE = "Europe/Paris";

/**
 * Convertit "18H45" -> "18h45", "15H00" -> "15h" (style Martin, sans minutes
 * inutiles quand elles sont nulles).
 */
function formatSessionTime(sessionStartTime: string): string {
  const match = /^(\d{1,2})H(\d{2})$/i.exec(sessionStartTime);
  if (!match) {
    return sessionStartTime;
  }
  const [, hour, minutes] = match;
  return minutes === "00" ? `${hour}h` : `${hour}h${minutes}`;
}

/** "2026-07-22" -> "mardi 22 juillet" */
function formatInformalDate(targetDate: string): string {
  const date = new Date(`${targetDate}T00:00:00Z`);
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

/**
 * Question de sondage WhatsApp — ask_poll ne supporte qu'un Oui/Non natif
 * (pas d'options personnalisées), l'heure reste donc dans la question plutôt
 * que dans des réponses distinctes.
 */
export function buildPollQuestion(targetDate: string, sessionStartTime: string): string {
  return `Squash ${formatInformalDate(targetDate)} à ${formatSessionTime(sessionStartTime)} ?`;
}
