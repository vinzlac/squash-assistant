import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { bookingRules, events } from "@squash-assistant/db/schema";
import { getDb } from "../../../../../lib/db";
import { formatDateTimeParis } from "../../../../../lib/datetime";
import { buildPollQuestionPreview } from "../../../../../lib/pipelinePreview";
import { getGroupMemberNames, getJob, getPollTally } from "../../../../../lib/worker";
import { isAdmin } from "../../../../../lib/authz";
import { Pipeline, type StepTimes } from "./Pipeline";
import { ResaEventsLive } from "./ResaEventsLive";

/**
 * Heure de déclenchement de chaque étape affichée dans Pipeline — dérivée du
 * premier event de chaque type pour ce job (poll/collect_votes/booking), pas
 * stockée ailleurs. L'étape 4 a deux issues possibles (annoncé ou annulé),
 * d'où la recherche sur les deux steps de detail.
 */
function computeStepTimes(jobEvents: (typeof events.$inferSelect)[]): StepTimes {
  const find = (predicate: (e: (typeof events.$inferSelect)) => boolean) => jobEvents.find(predicate)?.createdAt;
  return {
    step1: find((e) => e.type === "poll"),
    step2: find((e) => e.type === "collect_votes"),
    step3: find((e) => e.type === "booking" && (e.detail as { step?: string } | null)?.step === "plan-proposed"),
    step4: find(
      (e) =>
        e.type === "booking" &&
        ["announced", "cancelled"].includes((e.detail as { step?: string } | null)?.step ?? ""),
    ),
  };
}

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string; jobId: string }> }) {
  const { id, jobId } = await params;
  const db = getDb();

  const [rule] = await db.select().from(bookingRules).where(eq(bookingRules.id, id));
  if (!rule) {
    notFound();
  }

  const { job, status } = await getJob(id, jobId).catch(() => ({ job: undefined, status: undefined }));
  if (!job || !status) {
    notFound();
  }

  const pollTally = job.pollRequestId ? await getPollTally(id, jobId).catch(() => undefined) : undefined;
  const effectiveCandidateStartTimes = job.candidateStartTimes ?? rule.candidateStartTimes;
  const [playerNames, admin, jobEvents] = await Promise.all([
    getGroupMemberNames(id).catch(() => ({}) as Record<string, string>),
    isAdmin(),
    db.select().from(events).where(eq(events.jobRunId, jobId)).orderBy(asc(events.createdAt)),
  ]);
  const stepTimes = computeStepTimes(jobEvents);

  return (
    <main>
      <ResaEventsLive chatJid={rule.whatsappGroupJid} />
      <p>
        <Link href={`/rules/${id}/events`}>← Historique des jobs</Link>
        {" · "}
        <Link href={`/rules/${id}/edit`}>Éditer la règle</Link>
      </p>
      <h1>
        Job du {job.targetDate} « {rule.name ?? rule.id} »
      </h1>
      <p className="muted">
        Créé le {formatDateTimeParis(job.createdAt)} —{" "}
        <span className={`badge ${job.auto ? "badge-on" : "badge-off"}`}>{job.auto ? "auto" : "manuel"}</span>
      </p>
      {job.ruleSnapshot && (
        <details style={{ marginBottom: "1rem" }}>
          <summary className="muted">Règle utilisée à la création de ce job (ADR-014)</summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem" }}>{JSON.stringify(job.ruleSnapshot, null, 2)}</pre>
        </details>
      )}

      <Pipeline
        ruleId={id}
        job={job}
        status={status}
        candidateStartTimes={effectiveCandidateStartTimes}
        pollQuestionPreview={buildPollQuestionPreview(job.targetDate, effectiveCandidateStartTimes)}
        pollTally={pollTally}
        playerNames={playerNames}
        admin={admin}
        stepTimes={stepTimes}
      />
    </main>
  );
}
