import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../../../../../lib/db";
import { buildPollQuestionPreview } from "../../../../../lib/pipelinePreview";
import { getJob, getPollTally } from "../../../../../lib/worker";
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

  return (
    <main>
      <p>
        <Link href={`/rules/${id}/events`}>← Historique des jobs</Link>
      </p>
      <h1>
        Job du {job.targetDate} « {rule.id} »
      </h1>
      <p className="muted">Créé le {new Date(job.createdAt).toLocaleString("fr-FR")}.</p>

      <Pipeline
        ruleId={id}
        job={job}
        status={status}
        pollQuestionPreview={buildPollQuestionPreview(job.targetDate, rule.sessionStartTime)}
        pollTally={pollTally}
      />
    </main>
  );
}
