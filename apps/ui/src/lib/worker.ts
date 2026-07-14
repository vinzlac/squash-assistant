function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

async function callWorker(path: string, method: "GET" | "POST"): Promise<unknown> {
  const baseUrl = requireEnv("WORKER_INTERNAL_URL");
  const response = await fetch(`${baseUrl}${path}`, { method, cache: "no-store" });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const message = (body as { error?: string } | null)?.error ?? `Erreur worker (${response.status})`;
    throw new Error(message);
  }
  return body;
}

export function triggerWorkerAction(ruleId: string, action: "send-poll" | "decision" | "go"): Promise<unknown> {
  return callWorker(`/rules/${ruleId}/trigger/${action}`, "POST");
}

export type PipelineStage =
  | "not-started"
  | "awaiting-decision"
  | "awaiting-go"
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

export function getWorkerRuleStatus(ruleId: string): Promise<RuleExecutionStatus> {
  return callWorker(`/rules/${ruleId}/status`, "GET") as Promise<RuleExecutionStatus>;
}
