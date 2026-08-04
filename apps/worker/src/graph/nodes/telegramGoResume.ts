import type { JobRun } from "@squash-assistant/db/schema";

/**
 * Valeur de reprise LangGraph après confirmation Telegram "go".
 * - Job **auto** → `go-real` (réservation réelle) — la case dry-run UI n'existe que pour le manuel.
 * - Job **manuel** → `go` (dry-run) — une vraie réservation manuelle passe par l'UI (case décochée).
 * - Pas de confirmation → `timeout`.
 */
export function resumeValueForTelegramGo(job: Pick<JobRun, "auto">, confirmed: boolean): "go-real" | "go" | "timeout" {
  if (!confirmed) return "timeout";
  return job.auto ? "go-real" : "go";
}
