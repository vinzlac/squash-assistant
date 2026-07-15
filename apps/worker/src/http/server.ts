import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Database } from "@squash-assistant/db/client";
import { getBookingRuleById, incrementRunToken } from "../bookingRules.js";
import type { PipelineGraph } from "../graph/buildGraph.js";
import {
  forceGoConfirmation,
  getRuleExecutionStatus,
  triggerDecision,
  triggerSendPoll,
} from "../scheduler/scheduler.js";
import type { TelegramConfig } from "../telegram/telegram.js";

export interface HttpServerDeps {
  db: Database;
  graph: PipelineGraph;
  telegram: TelegramConfig;
}

const TRIGGER_ROUTE = /^\/rules\/([^/]+)\/trigger\/(send-poll|decision|go)$/;
const STATUS_ROUTE = /^\/rules\/([^/]+)\/status$/;
const NEW_RUN_ROUTE = /^\/rules\/([^/]+)\/new-run$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * API interne du worker (ClusterIP, jamais exposée via Ingress — cf. décision
 * LAN-only/mono-utilisateur déjà actée pour l'UI, pas d'auth applicative ici
 * non plus). Sert le déclenchement manuel des étapes depuis apps/ui.
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

  const triggerMatch = req.method === "POST" ? TRIGGER_ROUTE.exec(url.pathname) : null;
  if (triggerMatch) {
    const [, id, action] = triggerMatch;
    await handleTrigger(res, deps, id, action as "send-poll" | "decision" | "go");
    return;
  }

  const statusMatch = req.method === "GET" ? STATUS_ROUTE.exec(url.pathname) : null;
  if (statusMatch) {
    await handleStatus(res, deps, statusMatch[1]);
    return;
  }

  const newRunMatch = req.method === "POST" ? NEW_RUN_ROUTE.exec(url.pathname) : null;
  if (newRunMatch) {
    await handleNewRun(res, deps, newRunMatch[1]);
    return;
  }

  sendJson(res, 404, { error: "Route inconnue" });
}

async function handleTrigger(
  res: ServerResponse,
  deps: HttpServerDeps,
  ruleId: string,
  action: "send-poll" | "decision" | "go",
): Promise<void> {
  const rule = await getBookingRuleById(deps.db, ruleId);
  if (!rule) {
    sendJson(res, 404, { error: `Règle "${ruleId}" introuvable.` });
    return;
  }

  try {
    if (action === "send-poll") {
      await triggerSendPoll(rule, deps.graph, deps.telegram);
    } else if (action === "decision") {
      await triggerDecision(rule, deps.graph, deps.telegram);
    } else {
      await forceGoConfirmation(rule, deps.graph, deps.telegram);
    }
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleStatus(res: ServerResponse, deps: HttpServerDeps, ruleId: string): Promise<void> {
  const rule = await getBookingRuleById(deps.db, ruleId);
  if (!rule) {
    sendJson(res, 404, { error: `Règle "${ruleId}" introuvable.` });
    return;
  }

  const status = await getRuleExecutionStatus(rule, deps.graph);
  sendJson(res, 200, status);
}

/** "Nouveau job" : abandonne le thread courant (quel que soit son état) et repart de zéro. */
async function handleNewRun(res: ServerResponse, deps: HttpServerDeps, ruleId: string): Promise<void> {
  const rule = await incrementRunToken(deps.db, ruleId);
  if (!rule) {
    sendJson(res, 404, { error: `Règle "${ruleId}" introuvable.` });
    return;
  }
  sendJson(res, 200, { ok: true });
}
