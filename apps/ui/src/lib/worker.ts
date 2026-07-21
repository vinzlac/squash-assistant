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
  | "awaiting-plan"
  | "awaiting-go"
  | "error"
  | "finished-no-plan"
  | "finished-announced"
  | "finished-cancelled";

export interface ProposedBooking {
  court: number;
  userId: string;
  partnerId?: string;
  slotTime: string;
  slotEndTime: string;
}

export interface BookingPlanGroup {
  startTime: string;
  plan: { proposedBookings: ProposedBooking[]; warnings: string[] };
}

export interface RuleExecutionStatus {
  paused: boolean;
  pausedOn?: "await-decision-window" | "await-plan-trigger" | "await-go" | "unknown";
  stage: PipelineStage;
  targetDate: string;
  values: {
    pollRequestId?: string;
    confirmedPlayerIdsByTime?: Record<string, string[]>;
    bookingPlanGroups?: BookingPlanGroup[];
    goConfirmed?: boolean;
    announceMessage?: string;
  };
}

export interface JobRun {
  id: string;
  bookingRuleId: string;
  targetDate: string;
  candidateStartTimes: string[] | null;
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
  /** statut = 'oui'/'non'/'ambigu'/'aucune_reponse', ou le libellé exact de l'heure votée pour un sondage à choix multiples. */
  responses: Array<{ member: string; phone: string | null; statut: string }>;
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
  candidateStartTimes: string[],
): Promise<JobRun> {
  return callWorker(`/rules/${ruleId}/jobs/${jobId}/edit`, "POST", {
    targetDate,
    candidateStartTimes,
  }) as Promise<JobRun>;
}

export function triggerJobAction(
  ruleId: string,
  jobId: string,
  action: "send-poll" | "collect-votes" | "recollect-votes" | "plan" | "go" | "retry",
  body?: { realBooking?: boolean },
): Promise<unknown> {
  return callWorker(`/rules/${ruleId}/jobs/${jobId}/trigger/${action}`, "POST", body);
}

export function getPollTally(ruleId: string, jobId: string): Promise<PollTally> {
  return callWorker(`/rules/${ruleId}/jobs/${jobId}/poll-tally`, "GET") as Promise<PollTally>;
}

export function cancelPoll(ruleId: string, jobId: string): Promise<unknown> {
  return callWorker(`/rules/${ruleId}/jobs/${jobId}/cancel-poll`, "POST");
}

/** userId (resa-squash) → "Prénom Nom", pour l'affichage (le detail JSON brut garde les userId). */
export async function getGroupMemberNames(ruleId: string): Promise<Record<string, string>> {
  const { names } = (await callWorker(`/rules/${ruleId}/group-members`, "GET")) as { names: Record<string, string> };
  return names;
}
