import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { PipelineStage } from "../scheduler/scheduler.js";
import { parisCalendarDayBoundsUtc } from "../scheduler/weekKey.js";
import { filterCandidateTimesByClosures, type ClosureInterval } from "./filterCandidateTimes.js";

export interface ClosureImpactEntry {
  ruleId: string;
  /** Nom de la règle, repli sur son id — pour l'affichage dans l'aperçu UI. */
  ruleLabel: string;
  /** null : règle sans job encore créé pour cette date cible. */
  jobId: string | null;
  targetDate: string;
  stage: PipelineStage | "not-created";
  closedTimes: string[];
}

export interface ClosureImpact {
  /** Jobs en cours qui seront arrêtés par la cascade. */
  running: ClosureImpactEntry[];
  /** Jobs / règles qui recevront le message de fermeture à la place du sondage — information seulement. */
  planned: ClosureImpactEntry[];
  /** Jobs en stage `error` couverts — à annuler à la main, aucune action automatique. */
  errored: ClosureImpactEntry[];
}

export interface JobWithStage {
  job: JobRun;
  stage: PipelineStage;
}

const RUNNING_STAGES: ReadonlySet<PipelineStage> = new Set(["awaiting-decision", "awaiting-plan", "awaiting-go"]);
/** Borne de sécurité sur l'énumération des jours d'un intervalle (les fermetures sont courtes). */
const MAX_DAYS_SCANNED = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function ruleLabel(rule: BookingRule): string {
  return rule.name?.trim() || rule.id;
}

function parisYmd(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * Dates cibles (YYYY-MM-DD, Paris) d'un jour de semaine donné, strictement après
 * aujourd'hui, dont la journée chevauche l'intervalle de fermeture.
 */
export function targetDatesInInterval(interval: ClosureInterval, targetWeekday: number, now: Date): string[] {
  const today = parisYmd(now);
  const dates: string[] = [];
  let cursor = new Date(`${parisYmd(interval.startsAt)}T12:00:00Z`);
  for (let i = 0; i < MAX_DAYS_SCANNED; i += 1) {
    const ymd = cursor.toISOString().slice(0, 10);
    const { start } = parisCalendarDayBoundsUtc(ymd);
    if (start.getTime() >= interval.endsAt.getTime()) break;
    if (ymd > today && cursor.getUTCDay() === targetWeekday) dates.push(ymd);
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  return dates;
}

function closedTimesFor(interval: ClosureInterval, targetDate: string, times: string[]): string[] {
  return filterCandidateTimesByClosures(targetDate, times, [interval]).closedTimes;
}

/**
 * Détection pure de l'impact d'une fermeture (spec 2026-09-12) : un job est impacté dès
 * qu'UNE de ses heures candidates tombe dans l'intervalle — fermeture partielle ou journée entière.
 */
export function computeClosureImpact(
  interval: ClosureInterval,
  rules: BookingRule[],
  jobs: JobWithStage[],
  now: Date,
): ClosureImpact {
  const rulesById = new Map(rules.map((r) => [r.id, r]));
  const running: ClosureImpactEntry[] = [];
  const planned: ClosureImpactEntry[] = [];
  const errored: ClosureImpactEntry[] = [];
  const datesWithJob = new Set<string>();

  for (const { job, stage } of jobs) {
    const rule = rulesById.get(job.bookingRuleId);
    if (!rule || job.cancelledAt) continue;
    datesWithJob.add(`${rule.id}:${job.targetDate}`);
    const times = job.candidateStartTimes ?? rule.candidateStartTimes;
    const closedTimes = closedTimesFor(interval, job.targetDate, times);
    if (closedTimes.length === 0) continue;
    const entry: ClosureImpactEntry = {
      ruleId: rule.id,
      ruleLabel: ruleLabel(rule),
      jobId: job.id,
      targetDate: job.targetDate,
      stage,
      closedTimes,
    };
    if (RUNNING_STAGES.has(stage)) running.push(entry);
    else if (stage === "error") errored.push(entry);
    else if (stage === "not-started") planned.push(entry);
  }

  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const targetDate of targetDatesInInterval(interval, rule.targetWeekday, now)) {
      if (datesWithJob.has(`${rule.id}:${targetDate}`)) continue;
      const closedTimes = closedTimesFor(interval, targetDate, rule.candidateStartTimes);
      if (closedTimes.length === 0) continue;
      planned.push({ ruleId: rule.id, ruleLabel: ruleLabel(rule), jobId: null, targetDate, stage: "not-created", closedTimes });
    }
  }

  return { running, planned, errored };
}
