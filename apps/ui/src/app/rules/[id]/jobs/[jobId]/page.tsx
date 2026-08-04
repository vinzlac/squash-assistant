import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../../../../../lib/db";
import { formatDateTimeParis } from "../../../../../lib/datetime";
import { buildPollQuestionPreview } from "../../../../../lib/pipelinePreview";
import { getGroupMemberNames, getJob, getPollTally } from "../../../../../lib/worker";
import { isAdmin } from "../../../../../lib/authz";
import { Pipeline } from "./Pipeline";
import { ResaEventsLive } from "./ResaEventsLive";

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
  const [playerNames, admin] = await Promise.all([
    getGroupMemberNames(id).catch(() => ({}) as Record<string, string>),
    isAdmin(),
  ]);

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
      />
    </main>
  );
}
