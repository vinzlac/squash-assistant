function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

async function callWorker(path: string, method: "GET" | "POST", jsonBody?: unknown): Promise<unknown> {
  const baseUrl = requireEnv("WORKER_INTERNAL_URL");
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    cache: "no-store",
    ...(jsonBody !== undefined
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(jsonBody) }
      : {}),
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const message = (body as { error?: string } | null)?.error ?? `Erreur worker (${response.status})`;
    throw new Error(message);
  }
  return body;
}

export type PipelineStage =
  | "not-started"
  | "awaiting-decision"
  | "awaiting-go"
  | "error"
  | "finished-no-plan"
  | "finished-announced"
  | "finished-cancelled";

export interface ProposedBooking {
  court: number;
  beginTime: string;
  endTime: string;
  players: [string, string];
}

export interface RuleExecutionStatus {
  paused: boolean;
  pausedOn?: "await-decision-window" | "await-go" | "unknown";
  stage: PipelineStage;
  targetDate: string;
  values: {
    pollRequestId?: string;
    confirmedPlayerIds?: string[];
    bookingPlan?: { proposedBookings: ProposedBooking[]; warnings: string[] };
    goConfirmed?: boolean;
  };
}

export interface JobRun {
  id: string;
  bookingRuleId: string;
  targetDate: string;
  sessionStartTime: string | null;
  pollRequestId: string | null;
  pollMsgId: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

export interface JobWithStatus {
  job: JobRun;
  status: RuleExecutionStatus;
}

export interface PollTally {
  requestId: string;
  type: "poll" | "question";
  responses: Array<{ member: string; phone: string | null; statut: "oui" | "non" | "ambigu" | "aucune_reponse" }>;
  msgId?: string;
}

export function listJobs(ruleId: string): Promise<JobWithStatus[]> {
  return callWorker(`/rules/${ruleId}/jobs`, "GET") as Promise<JobWithStatus[]>;
}

export function getJob(ruleId: string, jobId: string): Promise<JobWithStatus> {
  return callWorker(`/rules/${ruleId}/jobs/${jobId}/status`, "GET") as Promise<JobWithStatus>;
}

export function createJob(ruleId: string): Promise<JobRun> {
  return callWorker(`/rules/${ruleId}/jobs`, "POST") as Promise<JobRun>;
}

export function editJob(
  ruleId: string,
  jobId: string,
  targetDate: string,
  sessionStartTime: string,
): Promise<JobRun> {
  return callWorker(`/rules/${ruleId}/jobs/${jobId}/edit`, "POST", { targetDate, sessionStartTime }) as Promise<JobRun>;
}

export function triggerJobAction(
  ruleId: string,
  jobId: string,
  action: "send-poll" | "decision" | "go" | "retry",
): Promise<unknown> {
  return callWorker(`/rules/${ruleId}/jobs/${jobId}/trigger/${action}`, "POST");
}

export function getPollTally(ruleId: string, jobId: string): Promise<PollTally> {
  return callWorker(`/rules/${ruleId}/jobs/${jobId}/poll-tally`, "GET") as Promise<PollTally>;
}

export function cancelPoll(ruleId: string, jobId: string): Promise<unknown> {
  return callWorker(`/rules/${ruleId}/jobs/${jobId}/cancel-poll`, "POST");
}
