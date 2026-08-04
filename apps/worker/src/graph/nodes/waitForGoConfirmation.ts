import { interrupt } from "@langchain/langgraph";
import type { PipelineStateType } from "../state.js";

/**
 * Nœud barrière, sans effet de bord (voir waitForDecisionWindow.ts) : isole
 * la pause "go" pour que bookSlots (dry-run + post Telegram) ne se
 * réexécute jamais à la reprise — éviter un double envoi du plan.
 *
 * Valeurs de reprise :
 * - `go-real` : réservation réelle — case dry-run décochée dans l'UI (job manuel),
 *   **ou** "go" Telegram sur un job **auto** (cf. resumeValueForTelegramGo).
 * - `go` : confirmation dry-run — bouton UI avec dry-run coché, ou "go" Telegram
 *   sur un job **manuel**.
 * - autre / timeout : pas de confirmation → announce n'envoie rien.
 */
export function waitForGoConfirmation(_state: PipelineStateType): Partial<PipelineStateType> {
  const resumeValue = interrupt({ type: "await-go" });
  const goConfirmed = resumeValue === "go" || resumeValue === "go-real";
  return { goConfirmed, dryRun: resumeValue !== "go-real" };
}
