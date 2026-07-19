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

function formatSessionTimeList(candidateStartTimes: string[]): string {
  const formatted = candidateStartTimes.map(formatSessionTime);
  if (formatted.length <= 1) return formatted[0] ?? "";
  return `${formatted.slice(0, -1).join(", ")} ou ${formatted[formatted.length - 1]}`;
}

/**
 * Une seule heure candidate : question fermée classique ("à 18h45 ?"), sondage
 * Oui/Non par défaut (huddle-bot ADR-011). Plusieurs heures candidates :
 * question ouverte sur l'heure, sondage à choix multiples — voir buildPollOptions.
 */
export function buildPollQuestion(targetDate: string, candidateStartTimes: string[]): string {
  const timeLabel = formatSessionTimeList(candidateStartTimes);
  return candidateStartTimes.length > 1
    ? `Squash ${formatInformalDate(targetDate)}, à quelle heure : ${timeLabel} ?`
    : `Squash ${formatInformalDate(targetDate)} à ${timeLabel} ?`;
}

/**
 * Options du sondage WhatsApp : une par heure candidate + "Non" explicite.
 * Avec une seule heure candidate, ça donne un sondage Oui/Non classique
 * (get_responses normalise déjà "Non" en minuscules — huddle-bot ADR-011) —
 * sauf que l'option "oui" s'appelle maintenant l'heure elle-même plutôt que
 * le mot "Oui" littéral (comportement légèrement différent mais équivalent :
 * collectVotes/resolveVotes filtre déjà sur le libellé de l'heure, pas "oui").
 */
export function buildPollOptions(candidateStartTimes: string[]): string[] {
  return [...candidateStartTimes, "Non"];
}
