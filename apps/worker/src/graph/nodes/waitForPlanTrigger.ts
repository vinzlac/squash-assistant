import { interrupt } from "@langchain/langgraph";
import type { PipelineStateType } from "../state.js";

/**
 * Nœud barrière, sans effet de bord (voir waitForDecisionWindow.ts) : sépare
 * CollectVotes (lire et interpréter les votes) de BookSlots (calculer le
 * plan de réservation dry-run) — décision du 2026-07-18 de rendre ces deux
 * actions déclenchables séparément (2 boutons dans l'UI) plutôt qu'une
 * seule action atomique, pour permettre de vérifier la liste des joueurs
 * confirmés avant de lancer le calcul du plan.
 */
export function waitForPlanTrigger(_state: PipelineStateType): Partial<PipelineStateType> {
  interrupt({ type: "await-plan-trigger" });
  return {};
}
