const TIMEZONE = "Europe/Paris";

/**
 * Convertit "18H45" -> "18h45", "15H00" -> "15h" (style Martin, sans minutes
 * inutiles quand elles sont nulles).
 */
export function formatSessionTime(sessionStartTime: string): string {
  const match = /^(\d{1,2})H(\d{2})$/i.exec(sessionStartTime);
  if (!match) {
    return sessionStartTime;
  }
  const [, hour, minutes] = match;
  return minutes === "00" ? `${hour}h` : `${hour}h${minutes}`;
}

/** "2026-07-22" -> "mardi 22 juillet" */
export function formatInformalDate(targetDate: string): string {
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

/** "09:00" -> "9h", "21:30" -> "21h30" (decisionTime est déjà en heure de Paris). */
function formatClockTime(hhmm: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return hhmm;
  const hour = Number(match[1]);
  return match[2] === "00" ? `${hour}h` : `${hour}h${match[2]}`;
}

function shiftDate(ymd: string, daysBefore: number): string {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - daysBefore);
  return date.toISOString().slice(0, 10);
}

/**
 * WhatsApp ne permet de supprimer un message « pour tout le monde » que pendant ~60 h : au-delà,
 * `delete_message` ne le retirerait que pour le bot. Marge de sécurité : 48 h. Partagé entre la
 * collecte (garde-fou de suppression) et l'envoi (mention « réponses jusqu'au » omise au-delà).
 */
export const POLL_DELETE_MAX_AGE_HOURS = 48;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Date calendaire et minutes depuis minuit, heure murale de Paris (jamais le fuseau du pod). */
function parisWallClock(now: Date): { date: string; minutes: number } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return { date, minutes: hour * 60 + minute };
}

/** Instant réel d'une heure murale de Paris (`minutes` depuis minuit le jour `ymd`), changement d'heure compris. */
function parisWallClockToInstant(ymd: string, minutes: number): number {
  const wallAsUtc = Date.parse(`${ymd}T00:00:00Z`) + minutes * MINUTE_MS;
  let instant = wallAsUtc;
  for (let i = 0; i < 2; i += 1) {
    const wall = parisWallClock(new Date(instant));
    instant += wallAsUtc - (Date.parse(`${wall.date}T00:00:00Z`) + wall.minutes * MINUTE_MS);
  }
  return instant;
}

/**
 * « lundi 5 octobre à 9h » : date cible − `decisionDaysBefore`, à `decisionTime` (spec 2026-10-09 §1.1).
 * null si cette clôture est déjà passée à `now` (job manuel tardif), si elle tombe à plus de
 * POLL_DELETE_MAX_AGE_HOURS de `now` (le sondage ne pourrait pas être supprimé à la collecte : la mention
 * serait fausse — ADR-037), ou si `decisionTime` est invalide.
 */
export function formatPollClosureDeadline(
  targetDate: string,
  decisionDaysBefore: number,
  decisionTime: string,
  now: Date,
): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(decisionTime.trim());
  if (!match) return null;
  const deadlineMinutes = Number(match[1]) * 60 + Number(match[2]);
  const deadlineDate = shiftDate(targetDate, decisionDaysBefore);
  const msUntilClosure = parisWallClockToInstant(deadlineDate, deadlineMinutes) - now.getTime();
  if (msUntilClosure <= 0 || msUntilClosure > POLL_DELETE_MAX_AGE_HOURS * HOUR_MS) return null;
  return `${formatInformalDate(deadlineDate)} à ${formatClockTime(decisionTime)}`;
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
  closureDeadline: string | null = null,
): string {
  const timeLabel = formatSessionTimeList(candidateStartTimes);
  const base =
    candidateStartTimes.length > 1
      ? `Squash ${formatInformalDate(targetDate)}, à quelle heure : ${timeLabel} ?`
      : `Squash ${formatInformalDate(targetDate)} à ${timeLabel} ?`;
  const closedPart = closedTimes.length > 0 ? ` (${closedTimes.map(formatSessionTime).join(", ")} : puc fermé)` : "";
  const closurePart = closureDeadline ? ` (${POLL_CLOSURE_MARKER} ${closureDeadline})` : "";
  return `${base}${closedPart}${closurePart}`;
}

/** Mention de clôture dans la question (spec 2026-10-09 §1.1) — partagée avec le garde-fou de suppression. */
export const POLL_CLOSURE_MARKER = "réponses jusqu'au";

/**
 * Le sondage envoyé annonçait-il sa clôture ? Lu sur `detail.question` de l'événement `poll`
 * (texte réellement envoyé) : seul un tel sondage peut être supprimé à la collecte (ADR-037).
 */
export function pollAnnouncedClosure(question: unknown): boolean {
  return typeof question === "string" && question.includes(POLL_CLOSURE_MARKER);
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
