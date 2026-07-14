import { interrupt } from "@langchain/langgraph";
import type { PipelineStateType } from "../state.js";

/**
 * Nœud barrière, sans effet de bord (voir waitForDecisionWindow.ts) : isole
 * la pause "go" pour que bookSlots (dry-run + post Telegram) ne se
 * réexécute jamais à la reprise — éviter un double envoi du plan.
 */
export function waitForGoConfirmation(_state: PipelineStateType): Partial<PipelineStateType> {
  const resumeValue = interrupt({ type: "await-go" });
  return { goConfirmed: resumeValue === "go" };
}
