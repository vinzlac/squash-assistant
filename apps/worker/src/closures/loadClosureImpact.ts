import type { Database } from "@squash-assistant/db/client";
import { loadBookingRules } from "../bookingRules.js";
import type { PipelineGraph } from "../graph/buildGraph.js";
import { listJobRuns } from "../jobRuns.js";
import { getJobExecutionStatus } from "../scheduler/scheduler.js";
import { parisCalendarDayBoundsUtc } from "../scheduler/weekKey.js";
import { computeClosureImpact, type ClosureImpact, type JobWithStage } from "./closureImpact.js";
import type { ClosureInterval } from "./filterCandidateTimes.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Marge d'un jour de part et d'autre : évite d'interroger Redis pour tout l'historique des jobs. */
function isNearInterval(targetDate: string, interval: ClosureInterval): boolean {
  const { start, end } = parisCalendarDayBoundsUtc(targetDate);
  return end.getTime() + DAY_MS > interval.startsAt.getTime() && start.getTime() - DAY_MS < interval.endsAt.getTime();
}

/** Charge règles, jobs proches de l'intervalle et leur stage LangGraph, puis délègue au calcul pur. */
export async function loadClosureImpact(
  deps: { db: Database; graph: PipelineGraph },
  interval: ClosureInterval,
  now: Date = new Date(),
): Promise<ClosureImpact> {
  const rules = await loadBookingRules(deps.db);
  const jobsWithStage: JobWithStage[] = [];
  for (const rule of rules) {
    const jobs = await listJobRuns(deps.db, rule.id);
    for (const job of jobs) {
      if (job.cancelledAt || !isNearInterval(job.targetDate, interval)) continue;
      const status = await getJobExecutionStatus(rule, job, deps.graph);
      jobsWithStage.push({ job, stage: status.stage });
    }
  }
  return computeClosureImpact(interval, rules, jobsWithStage, now);
}
