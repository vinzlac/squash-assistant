import type { BookingRule } from "@squash-assistant/db/schema";

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
  | "finished-cancelled"
  | "finished-club-closed";

export interface ProposedBooking {
  sessionId: string;
  court: number;
  userId: string;
  partnerId?: string;
  slotTime: string;
  slotEndTime: string;
}

export interface BookingPlanGroup {
  startTime: string;
  plan: {
    proposedBookings: ProposedBooking[];
    warnings: string[];
    meta: { pairCount: number; slotsPerPlayer: number };
  };
  /** sessionId hors de la fenêtre acceptée — affichés mais jamais réservés (ADR-014). */
  outOfWindowSessionIds: string[];
}

/** Ligne du plan refusée à la réservation réelle (étape 4) — miroir de `ReservationFailure` côté worker (ADR-027). */
export interface ReservationFailure {
  sessionId: string;
  court: number;
  slotTime: string;
  slotEndTime: string;
  userId: string;
  partnerId: string | null;
  reason: string | null;
  message: string;
  rawError: string;
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
    /** Refus de réservation réelle : les résas prises sont conservées, celles-ci sont signalées (ADR-027). */
    reservationFailures?: ReservationFailure[];
  };
}

export interface JobRun {
  id: string;
  bookingRuleId: string;
  targetDate: string;
  candidateStartTimes: string[] | null;
  pollRequestId: string | null;
  pollMsgId: string | null;
  /** Copie figée de la BookingRule à la création du job — traçabilité si la règle est éditée après coup (ADR-014). */
  ruleSnapshot: BookingRule | null;
  cancelledAt: string | null;
  /** Cause lisible de l'annulation (ex. « PUC fermé : tournoi »), null pour une annulation manuelle. */
  cancelReason: string | null;
  clubClosureId: string | null;
  /** true si créé automatiquement par le scheduler (cron), false si créé manuellement depuis l'UI. */
  auto: boolean;
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
  action: "send-poll" | "collect-votes" | "recollect-votes" | "plan" | "recompute-plan" | "go" | "retry",
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

/** Miroir de `ClosureImpactEntry` côté worker (apps/worker/src/closures/closureImpact.ts). */
export interface ClosureImpactEntry {
  ruleId: string;
  ruleLabel: string;
  jobId: string | null;
  targetDate: string;
  stage: PipelineStage | "not-created";
  closedTimes: string[];
}

export interface ClosureImpact {
  running: ClosureImpactEntry[];
  planned: ClosureImpactEntry[];
  errored: ClosureImpactEntry[];
}

export interface CreateClosureResponse {
  closureId: string;
  cancelled: ClosureImpactEntry[];
  failed: Array<{ jobId: string; ruleId: string; error: string }>;
  planned: ClosureImpactEntry[];
  errored: ClosureImpactEntry[];
  /** Fermeture enregistrée mais calcul d'impact/cascade en échec côté worker — ne pas la recréer. */
  cascadeError?: string;
}

/** Aperçu (lecture seule) des jobs impactés par une fermeture PUC — spec 2026-09-12. */
export function previewClubClosure(startsAt: Date, endsAt: Date): Promise<ClosureImpact> {
  return callWorker("/club-closures/preview", "POST", {
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  }) as Promise<ClosureImpact>;
}

/** Crée la fermeture et arrête les jobs en cours impactés (sondage supprimé + message WhatsApp). */
export function createClubClosureWithCascade(startsAt: Date, endsAt: Date, label: string): Promise<CreateClosureResponse> {
  return callWorker("/club-closures", "POST", {
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    label,
  }) as Promise<CreateClosureResponse>;
}

/** Calcule (et persiste) le plan d'un scénario de simulation — voir docs/adr/ADR-019. */
export function simulateScenario(ruleId: string, scenarioId: string): Promise<{ scenario: unknown; bookingPlanGroups: unknown[] }> {
  return callWorker(`/rules/${ruleId}/scenarios/${scenarioId}/simulate`, "POST") as Promise<{
    scenario: unknown;
    bookingPlanGroups: unknown[];
  }>;
}

/** userId (resa-squash) → "Prénom Nom", pour l'affichage (le detail JSON brut garde les userId). */
export async function getGroupMemberNames(ruleId: string): Promise<Record<string, string>> {
  const { names } = (await callWorker(`/rules/${ruleId}/group-members`, "GET")) as { names: Record<string, string> };
  return names;
}

/**
 * Favoris du compte resa-squash (userId → "Prénom Nom") — vivier de choix du joker d'une règle
 * (ADR-024). Indépendant d'une règle : les favoris appartiennent au compte, pas au groupe.
 */
export async function getFavoriteNames(): Promise<Record<string, string>> {
  const { names } = (await callWorker("/favorites", "GET")) as { names: Record<string, string> };
  return names;
}

/** Sous-ensemble de BookingRule extrait par le LLM (ADR-015) — miroir de ExtractableRuleParams côté worker. */
export interface ExtractableRuleParams {
  candidateStartTimes: string[];
  targetWeekday: number;
  pollDaysBefore: number;
  pollTime: string;
  decisionDaysBefore: number;
  decisionTime: string;
  maxCourtsPerSlot: number;
  minPlayersPerCourt: number;
  maxPlayersPerCourt: number;
  maxReservationsPerPlayer: number;
  priorityBookers: string[];
  preferMinPlayersPerCourt: boolean;
  courtPriority: number[];
  availabilityWindowHours: number;
  maxDailyReservationsPerPlayer: number;
  jokerBookerId: string | null;
  substituteBookers: string[];
  unexpectedPlayersMargin: number;
  cronJitterWindowMinutes: number;
}

/** Extraction LLM (Claude) des paramètres d'une règle à partir d'une description en français — voir ADR-015. */
export function generateRuleParams(description: string): Promise<ExtractableRuleParams> {
  return callWorker("/rules/generate-params", "POST", { description }) as Promise<ExtractableRuleParams>;
}

export interface WorkerHealth {
  ok: boolean;
  gitSha: string;
  gitCommitDate: string;
  gitCommitMessage: string;
  startedAt: string;
}

/** Infos de build/démarrage du worker (image et conteneur potentiellement différents de ceux de l'UI, déployés indépendamment). */
export function getWorkerHealth(): Promise<WorkerHealth> {
  return callWorker("/health", "GET") as Promise<WorkerHealth>;
}

/**
 * Recharge les crons du worker depuis la DB (à chaud). Best-effort côté actions UI :
 * une indispo worker ne doit pas bloquer la sauvegarde de règle.
 */
export function reloadScheduler(): Promise<{ ok: boolean; enabledRuleIds: string[] }> {
  return callWorker("/scheduler/reload", "POST") as Promise<{ ok: boolean; enabledRuleIds: string[] }>;
}
