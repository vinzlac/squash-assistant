import { interrupt } from "@langchain/langgraph";
import type { PipelineStateType } from "../state.js";

/**
 * Nœud barrière, sans effet de bord (voir waitForDecisionWindow.ts) : isole
 * la pause "go" pour que bookSlots (dry-run + post Telegram) ne se
 * réexécute jamais à la reprise — éviter un double envoi du plan.
 *
 * `resumeValue === "go-real"` : réservation réelle explicitement demandée
 * (case "dry-run" décochée dans l'UI, cf. Pipeline.tsx/forceGoConfirmation) —
 * announce.ts appelle alors reserve_slot pour de vrai. Toute autre voie de
 * confirmation (bouton "go" par défaut, "go" tapé sur Telegram via
 * awaitGoAndResume) reste en dry-run : seule une case explicitement décochée
 * dans l'UI peut déclencher une vraie réservation.
 */
export function waitForGoConfirmation(_state: PipelineStateType): Partial<PipelineStateType> {
  const resumeValue = interrupt({ type: "await-go" });
  const goConfirmed = resumeValue === "go" || resumeValue === "go-real";
  return { goConfirmed, dryRun: resumeValue !== "go-real" };
}
