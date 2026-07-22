import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../../../../../lib/db";
import { buildPollQuestionPreview } from "../../../../../lib/pipelinePreview";
import { getGroupMemberNames, getJob, getPollTally } from "../../../../../lib/worker";
import { Pipeline } from "./Pipeline";

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
  const playerNames = await getGroupMemberNames(id).catch(() => ({}) as Record<string, string>);

  return (
    <main>
      <p>
        <Link href={`/rules/${id}/events`}>← Historique des jobs</Link>
      </p>
      <h1>
        Job du {job.targetDate} « {rule.id} »
      </h1>
      <p className="muted">Créé le {new Date(job.createdAt).toLocaleString("fr-FR")}.</p>
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
      />
    </main>
  );
}
