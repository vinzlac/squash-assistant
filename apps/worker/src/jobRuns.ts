import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "@squash-assistant/db/client";
import { jobRuns, type BookingRule, type JobRun } from "@squash-assistant/db/schema";

export function threadIdForJob(bookingRuleId: string, jobId: string): string {
  return `${bookingRuleId}:${jobId}`;
}

/** Fige `rule` dans `ruleSnapshot` à la création du job — traçabilité si la règle est éditée après coup (ADR-014). */
export async function createJobRun(db: Database, rule: BookingRule, targetDate: string): Promise<JobRun> {
  const [job] = await db
    .insert(jobRuns)
    .values({
      bookingRuleId: rule.id,
      targetDate,
      candidateStartTimes: rule.candidateStartTimes,
      ruleSnapshot: rule,
    })
    .returning();
  return job;
}

export async function listJobRuns(db: Database, bookingRuleId: string): Promise<JobRun[]> {
  return db.select().from(jobRuns).where(eq(jobRuns.bookingRuleId, bookingRuleId)).orderBy(desc(jobRuns.createdAt));
}

export async function getJobRunById(db: Database, bookingRuleId: string, jobId: string): Promise<JobRun | undefined> {
  const [job] = await db
    .select()
    .from(jobRuns)
    .where(and(eq(jobRuns.bookingRuleId, bookingRuleId), eq(jobRuns.id, jobId)));
  return job;
}

/** Utilisé par le cron pour éviter de renvoyer un 2e sondage si pollCron se déclenche deux fois pour la même date cible. */
export async function findActiveJobRunForDate(
  db: Database,
  bookingRuleId: string,
  targetDate: string,
): Promise<JobRun | undefined> {
  const [job] = await db
    .select()
    .from(jobRuns)
    .where(and(eq(jobRuns.bookingRuleId, bookingRuleId), eq(jobRuns.targetDate, targetDate), isNull(jobRuns.cancelledAt)))
    .orderBy(desc(jobRuns.createdAt));
  return job;
}

export async function setJobRunPollInfo(
  db: Database,
  jobId: string,
  pollRequestId: string,
  pollMsgId: string | undefined,
): Promise<void> {
  await db.update(jobRuns).set({ pollRequestId, pollMsgId: pollMsgId ?? null }).where(eq(jobRuns.id, jobId));
}

export async function cancelJobRun(db: Database, jobId: string): Promise<JobRun | undefined> {
  const [job] = await db.update(jobRuns).set({ cancelledAt: new Date() }).where(eq(jobRuns.id, jobId)).returning();
  return job;
}

/**
 * Modifie la date cible / les heures candidates d'un job pas encore démarré
 * (mode manuel — avant l'envoi du sondage). Ne touche jamais la règle elle-même.
 */
export async function updateJobRunSchedule(
  db: Database,
  jobId: string,
  targetDate: string,
  candidateStartTimes: string[],
): Promise<JobRun | undefined> {
  const [job] = await db
    .update(jobRuns)
    .set({ targetDate, candidateStartTimes })
    .where(eq(jobRuns.id, jobId))
    .returning();
  return job;
}
