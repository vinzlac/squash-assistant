import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Database } from "@squash-assistant/db/client";
import { getBookingRuleById } from "../bookingRules.js";
import type { PipelineGraph } from "../graph/buildGraph.js";
import { cancelJobRun, createJobRun, getJobRunById, listJobRuns } from "../jobRuns.js";
import { deleteMessage, getResponses } from "../mcp/huddleBot.js";
import type { McpConnection } from "../mcp/client.js";
import {
  forceGoConfirmation,
  getJobExecutionStatus,
  triggerDecision,
  triggerRetry,
  triggerSendPoll,
} from "../scheduler/scheduler.js";
import { computeTargetDate } from "../scheduler/weekKey.js";
import type { TelegramConfig } from "../telegram/telegram.js";

export interface HttpServerDeps {
  db: Database;
  graph: PipelineGraph;
  telegram: TelegramConfig;
  huddleBot: McpConnection;
}

const JOBS_ROUTE = /^\/rules\/([^/]+)\/jobs$/;
const JOB_STATUS_ROUTE = /^\/rules\/([^/]+)\/jobs\/([^/]+)\/status$/;
const JOB_TRIGGER_ROUTE = /^\/rules\/([^/]+)\/jobs\/([^/]+)\/trigger\/(send-poll|decision|go|retry)$/;
const JOB_POLL_TALLY_ROUTE = /^\/rules\/([^/]+)\/jobs\/([^/]+)\/poll-tally$/;
const JOB_CANCEL_POLL_ROUTE = /^\/rules\/([^/]+)\/jobs\/([^/]+)\/cancel-poll$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * API interne du worker (ClusterIP, jamais exposée via Ingress — cf. décision
 * LAN-only/mono-utilisateur déjà actée pour l'UI, pas d'auth applicative ici
 * non plus). Sert le déclenchement manuel des étapes depuis apps/ui, avec un
 * modèle "N jobs par règle" (une règle peut avoir plusieurs exécutions du
 * pipeline en parallèle, cf. packages/db/src/schema.ts jobRuns).
 */
export function startHttpServer(deps: HttpServerDeps, port = 8080): void {
  const server = createServer((req, res) => {
    void handleRequest(req, res, deps);
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[squash-assistant] API interne à l'écoute sur le port ${port}.`);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const jobsMatch = url.pathname.match(JOBS_ROUTE);
  if (jobsMatch) {
    if (req.method === "GET") {
      await handleListJobs(res, deps, jobsMatch[1]);
      return;
    }
    if (req.method === "POST") {
      await handleCreateJob(res, deps, jobsMatch[1]);
      return;
    }
  }

  const statusMatch = req.method === "GET" ? JOB_STATUS_ROUTE.exec(url.pathname) : null;
  if (statusMatch) {
    await handleJobStatus(res, deps, statusMatch[1], statusMatch[2]);
    return;
  }

  const triggerMatch = req.method === "POST" ? JOB_TRIGGER_ROUTE.exec(url.pathname) : null;
  if (triggerMatch) {
    const [, ruleId, jobId, action] = triggerMatch;
    await handleTrigger(res, deps, ruleId, jobId, action as "send-poll" | "decision" | "go" | "retry");
    return;
  }

  const pollTallyMatch = req.method === "GET" ? JOB_POLL_TALLY_ROUTE.exec(url.pathname) : null;
  if (pollTallyMatch) {
    await handlePollTally(res, deps, pollTallyMatch[1], pollTallyMatch[2]);
    return;
  }

  const cancelPollMatch = req.method === "POST" ? JOB_CANCEL_POLL_ROUTE.exec(url.pathname) : null;
  if (cancelPollMatch) {
    await handleCancelPoll(res, deps, cancelPollMatch[1], cancelPollMatch[2]);
    return;
  }

  sendJson(res, 404, { error: "Route inconnue" });
}

async function handleListJobs(res: ServerResponse, deps: HttpServerDeps, ruleId: string): Promise<void> {
  const rule = await getBookingRuleById(deps.db, ruleId);
  if (!rule) {
    sendJson(res, 404, { error: `Règle "${ruleId}" introuvable.` });
    return;
  }
  const jobs = await listJobRuns(deps.db, ruleId);
  const jobsWithStatus = await Promise.all(
    jobs.map(async (job) => ({ job, status: await getJobExecutionStatus(rule, job, deps.graph) })),
  );
  sendJson(res, 200, jobsWithStatus);
}

/** "Nouveau job" : crée un job supplémentaire (indépendant des autres) pour cette règle. */
async function handleCreateJob(res: ServerResponse, deps: HttpServerDeps, ruleId: string): Promise<void> {
  const rule = await getBookingRuleById(deps.db, ruleId);
  if (!rule) {
    sendJson(res, 404, { error: `Règle "${ruleId}" introuvable.` });
    return;
  }
  const targetDate = computeTargetDate(new Date(), rule.targetWeekdayOffset);
  const job = await createJobRun(deps.db, ruleId, targetDate);
  sendJson(res, 200, job);
}

async function handleJobStatus(
  res: ServerResponse,
  deps: HttpServerDeps,
  ruleId: string,
  jobId: string,
): Promise<void> {
  const rule = await getBookingRuleById(deps.db, ruleId);
  if (!rule) {
    sendJson(res, 404, { error: `Règle "${ruleId}" introuvable.` });
    return;
  }
  const job = await getJobRunById(deps.db, ruleId, jobId);
  if (!job) {
    sendJson(res, 404, { error: `Job "${jobId}" introuvable pour la règle "${ruleId}".` });
    return;
  }
  const status = await getJobExecutionStatus(rule, job, deps.graph);
  sendJson(res, 200, { job, status });
}

async function handleTrigger(
  res: ServerResponse,
  deps: HttpServerDeps,
  ruleId: string,
  jobId: string,
  action: "send-poll" | "decision" | "go" | "retry",
): Promise<void> {
  const rule = await getBookingRuleById(deps.db, ruleId);
  if (!rule) {
    sendJson(res, 404, { error: `Règle "${ruleId}" introuvable.` });
    return;
  }
  const job = await getJobRunById(deps.db, ruleId, jobId);
  if (!job) {
    sendJson(res, 404, { error: `Job "${jobId}" introuvable pour la règle "${ruleId}".` });
    return;
  }
  if (job.cancelledAt) {
    sendJson(res, 409, { error: `Job "${jobId}" annulé — impossible de le relancer.` });
    return;
  }

  try {
    if (action === "send-poll") {
      await triggerSendPoll(rule, job, deps.graph, deps.telegram);
    } else if (action === "decision") {
      await triggerDecision(rule, job, deps.graph, deps.telegram);
    } else if (action === "retry") {
      await triggerRetry(rule, job, deps.graph, deps.telegram);
    } else {
      await forceGoConfirmation(rule, job, deps.graph, deps.telegram);
    }
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Consultation en direct du tally des votes (get_responses), sans toucher à
 * l'état LangGraph — répétable à volonté pendant la fenêtre de décision,
 * puisque les réponses peuvent arriver progressivement dans le temps.
 */
async function handlePollTally(
  res: ServerResponse,
  deps: HttpServerDeps,
  ruleId: string,
  jobId: string,
): Promise<void> {
  const job = await getJobRunById(deps.db, ruleId, jobId);
  if (!job) {
    sendJson(res, 404, { error: `Job "${jobId}" introuvable pour la règle "${ruleId}".` });
    return;
  }
  if (!job.pollRequestId) {
    sendJson(res, 409, { error: "Sondage pas encore envoyé pour ce job." });
    return;
  }
  try {
    const tally = await getResponses(deps.huddleBot.client, job.pollRequestId);
    sendJson(res, 200, tally);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Annule le sondage envoyé pour ce job (supprime le message WhatsApp) et marque le job comme annulé. */
async function handleCancelPoll(
  res: ServerResponse,
  deps: HttpServerDeps,
  ruleId: string,
  jobId: string,
): Promise<void> {
  const rule = await getBookingRuleById(deps.db, ruleId);
  const job = await getJobRunById(deps.db, ruleId, jobId);
  if (!rule || !job) {
    sendJson(res, 404, { error: `Règle ou job introuvable.` });
    return;
  }
  if (!job.pollMsgId) {
    sendJson(res, 409, {
      error: "msgId du sondage indisponible — impossible de le supprimer (sondage envoyé avant ce champ, ou pas encore envoyé).",
    });
    return;
  }
  try {
    await deleteMessage(deps.huddleBot.client, rule.whatsappGroupJid, job.pollMsgId);
    await cancelJobRun(deps.db, jobId);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
