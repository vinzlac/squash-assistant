import type { ServerResponse } from "node:http";

/** Réponse JSON de l'API interne du worker — partagé entre server.ts et les handlers extraits. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
