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

/** Réplique de POLL_DELETE_MAX_AGE_HOURS (apps/worker/src/graph/nodes/pollQuestion.ts) — doit rester identique. */
const POLL_DELETE_MAX_AGE_HOURS = 48;
/** Réplique de POLL_CLOSURE_MENTION_MARGIN_MINUTES (apps/worker/src/graph/nodes/pollQuestion.ts) — doit rester identique. */
const POLL_CLOSURE_MENTION_MARGIN_MINUTES = 15;
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
 * POLL_DELETE_MAX_AGE_HOURS − POLL_CLOSURE_MENTION_MARGIN_MINUTES de `now` (le sondage ne pourrait pas être supprimé à la collecte : la mention
 * serait fausse), ou si `decisionTime` est invalide.
 */
function formatPollClosureDeadline(
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
  const maxMsUntilClosure = POLL_DELETE_MAX_AGE_HOURS * HOUR_MS - POLL_CLOSURE_MENTION_MARGIN_MINUTES * MINUTE_MS;
  if (msUntilClosure <= 0 || msUntilClosure > maxMsUntilClosure) return null;
  return `${formatInformalDate(deadlineDate)} à ${formatClockTime(decisionTime)}`;
}

export interface PollClosureSettings {
  decisionDaysBefore: number;
  decisionTime: string;
}

export function buildPollQuestionPreview(
  targetDate: string,
  candidateStartTimes: string[],
  closure?: PollClosureSettings,
  now: Date = new Date(),
): string {
  const timeLabel = formatSessionTimeList(candidateStartTimes);
  const base =
    candidateStartTimes.length > 1
      ? `Squash ${formatInformalDate(targetDate)}, à quelle heure : ${timeLabel} ?`
      : `Squash ${formatInformalDate(targetDate)} à ${timeLabel} ?`;
  const deadline = closure
    ? formatPollClosureDeadline(targetDate, closure.decisionDaysBefore, closure.decisionTime, now)
    : null;
  return deadline ? `${base} (réponses jusqu'au ${deadline})` : base;
}
