import type { ServerResponse } from "node:http";
import { clubClosures } from "@squash-assistant/db/schema";
import { getBookingRuleById } from "../bookingRules.js";
import { cancelJobForClosure } from "../closures/cancelJobForClosure.js";
import type { ClosureImpactEntry } from "../closures/closureImpact.js";
import type { ClosureInterval } from "../closures/filterCandidateTimes.js";
import { loadClosureImpact } from "../closures/loadClosureImpact.js";
import { getJobRunById } from "../jobRuns.js";
import type { HttpServerDeps } from "./server.js";

export interface CreateClosureResponse {
  closureId: string;
  cancelled: ClosureImpactEntry[];
  failed: Array<{ jobId: string; ruleId: string; error: string }>;
  planned: ClosureImpactEntry[];
  errored: ClosureImpactEntry[];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseDate(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseClosureInterval(
  body: Record<string, unknown>,
): { ok: true; interval: ClosureInterval } | { ok: false; error: string } {
  const startsAt = parseDate(body.startsAt);
  const endsAt = parseDate(body.endsAt);
  if (!startsAt || !endsAt) return { ok: false, error: "Dates de début/fin invalides (ISO 8601 attendu)." };
  if (endsAt.getTime() <= startsAt.getTime()) return { ok: false, error: "La fin doit être après le début." };
  return { ok: true, interval: { startsAt, endsAt } };
}

/** Lecture seule : impact d'une fermeture hypothétique sur les jobs en cours / prévus. */
export async function handleClubClosurePreview(
  res: ServerResponse,
  deps: HttpServerDeps,
  body: Record<string, unknown>,
): Promise<void> {
  const parsed = parseClosureInterval(body);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  try {
    sendJson(res, 200, await loadClosureImpact(deps, parsed.interval));
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Crée la fermeture puis arrête tout job en cours impacté — l'impact est recalculé ICI, au
 * moment de la confirmation, pas repris de l'aperçu (spec 2026-09-12). L'échec d'un job
 * n'arrête pas les autres.
 */
export async function handleClubClosureCreate(
  res: ServerResponse,
  deps: HttpServerDeps,
  body: Record<string, unknown>,
): Promise<void> {
  const parsed = parseClosureInterval(body);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) {
    sendJson(res, 400, { error: "Le libellé (raison de la fermeture) est obligatoire." });
    return;
  }

  try {
    const [inserted] = await deps.db
      .insert(clubClosures)
      .values({ startsAt: parsed.interval.startsAt, endsAt: parsed.interval.endsAt, label })
      .returning();
    const closure = { id: inserted!.id, label };
    const impact = await loadClosureImpact(deps, { ...parsed.interval, label });

    const cancelled: ClosureImpactEntry[] = [];
    const failed: CreateClosureResponse["failed"] = [];
    for (const entry of impact.running) {
      if (!entry.jobId) continue;
      const rule = await getBookingRuleById(deps.db, entry.ruleId);
      const job = await getJobRunById(deps.db, entry.ruleId, entry.jobId);
      if (!rule || !job) {
        failed.push({ jobId: entry.jobId, ruleId: entry.ruleId, error: "Règle ou job introuvable." });
        continue;
      }
      const result = await cancelJobForClosure(deps, rule, job, entry, closure);
      if (result.ok) cancelled.push(entry);
      else failed.push({ jobId: entry.jobId, ruleId: entry.ruleId, error: result.error });
    }

    const response: CreateClosureResponse = {
      closureId: closure.id,
      cancelled,
      failed,
      planned: impact.planned,
      errored: impact.errored,
    };
    sendJson(res, 200, response);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
