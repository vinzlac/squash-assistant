import { interrupt } from "@langchain/langgraph";
import type { PipelineStateType } from "../state.js";

/**
 * Nœud barrière, sans effet de bord : sépare SendPoll (déclenché par le cron
 * du matin) de CollectVotes (déclenché par le cron du soir). Un nœud LangGraph
 * rejoue entièrement sa fonction à la reprise d'un interrupt() — isoler la
 * pause dans un nœud pur évite de réexécuter les appels MCP/Telegram de
 * SendPoll ou CollectVotes (même précaution pour le "go", cf. waitForGoConfirmation.ts).
 */
export function waitForDecisionWindow(_state: PipelineStateType): Partial<PipelineStateType> {
  interrupt({ type: "await-decision-window" });
  return {};
}
