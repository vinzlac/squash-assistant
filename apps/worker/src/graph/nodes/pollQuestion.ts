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

/** « (tournoi / travaux) » à partir des libellés de fermeture, dédupliqués ; chaîne vide sans libellé. */
export function formatClosureReason(labels: Array<string | null | undefined>): string {
  const unique = [...new Set(labels.map((l) => l?.trim()).filter((l): l is string => Boolean(l)))];
  return unique.length === 0 ? "" : ` (${unique.join(" / ")})`;
}

/** Message envoyé à la place du sondage quand la date cible est déjà fermée (cas A du design 2026-08-09). */
export function buildClubClosedMessage(targetDate: string, labels: Array<string | null | undefined> = []): string {
  return `Hello la team ! Le PUC est fermé ${formatInformalDate(targetDate)}${formatClosureReason(labels)}, donc pas de squash ce jour-là 😕 Pas de sondage cette semaine, on remet ça la semaine suivante 💪`;
}

/** Message envoyé quand une fermeture déclarée après coup arrête un job en cours (spec 2026-09-12). */
export function buildClosureCancelMessage(
  targetDate: string,
  labels: Array<string | null | undefined>,
  pollDeleted: boolean,
): string {
  const tail = pollDeleted ? "J'ai supprimé le sondage" : "Ignorez le sondage du coup";
  return `Hello la team ! Mauvaise nouvelle : le PUC est fermé ${formatInformalDate(targetDate)}${formatClosureReason(labels)}, donc pas de squash ce jour-là 😕 ${tail}, on remet ça la semaine prochaine 💪`;
}

/**
 * Une seule heure candidate : question fermée classique ("à 18h45 ?"), sondage
 * Oui/Non par défaut (huddle-bot ADR-011). Plusieurs heures candidates :
 * question ouverte sur l'heure, sondage à choix multiples — voir buildPollOptions.
 */
export function buildPollQuestion(
  targetDate: string,
  candidateStartTimes: string[],
  closedTimes: string[] = [],
): string {
  const timeLabel = formatSessionTimeList(candidateStartTimes);
  const base =
    candidateStartTimes.length > 1
      ? `Squash ${formatInformalDate(targetDate)}, à quelle heure : ${timeLabel} ?`
      : `Squash ${formatInformalDate(targetDate)} à ${timeLabel} ?`;
  if (closedTimes.length === 0) return base;
  const closedLabel = closedTimes.map(formatSessionTime).join(", ");
  return `${base} (${closedLabel} : puc fermé)`;
}

/**
 * Libellé exact de l'option "prête-nom volontaire" — renvoyé tel quel par
 * get_responses (statut) comme n'importe quelle option de sondage à choix
 * multiples, aucune classification LLM impliquée (voir ADR-017). Partagé
 * entre buildPollOptions (construction) et resolveVotes (résolution) pour
 * ne jamais désynchroniser les deux côtés.
 */
export const SUBSTITUTE_VOLUNTEER_POLL_OPTION = "Non, mais je peux prêter mon nom";

/**
 * Options du sondage WhatsApp : une par heure candidate + "Non" explicite +
 * l'option prête-nom volontaire (ADR-017). Avec une seule heure candidate,
 * ça donne un sondage Oui/Non classique (get_responses normalise déjà "Non"
 * en minuscules — huddle-bot ADR-011) — sauf que l'option "oui" s'appelle
 * maintenant l'heure elle-même plutôt que le mot "Oui" littéral
 * (comportement légèrement différent mais équivalent : collectVotes/
 * resolveVotes filtre déjà sur le libellé de l'heure, pas "oui").
 */
export function buildPollOptions(candidateStartTimes: string[]): string[] {
  return [...candidateStartTimes, "Non", SUBSTITUTE_VOLUNTEER_POLL_OPTION];
}
