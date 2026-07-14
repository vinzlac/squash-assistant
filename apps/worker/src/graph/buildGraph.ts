import { END, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { createAnnounceNode } from "./nodes/announce.js";
import { hasProposedBookings, createBookSlotsNode } from "./nodes/bookSlots.js";
import { createCollectVotesNode } from "./nodes/collectVotes.js";
import { createSendPollNode } from "./nodes/sendPoll.js";
import { waitForDecisionWindow } from "./nodes/waitForDecisionWindow.js";
import { waitForGoConfirmation } from "./nodes/waitForGoConfirmation.js";
import type { GraphDependencies } from "./dependencies.js";
import { PipelineState, type PipelineStateType } from "./state.js";

export function buildPipelineGraph(deps: GraphDependencies, checkpointer: BaseCheckpointSaver) {
  const graph = new StateGraph(PipelineState)
    .addNode("sendPoll", createSendPollNode(deps))
    .addNode("waitForDecisionWindow", waitForDecisionWindow)
    .addNode("collectVotes", createCollectVotesNode(deps))
    .addNode("bookSlots", createBookSlotsNode(deps))
    .addNode("waitForGoConfirmation", waitForGoConfirmation)
    .addNode("announce", createAnnounceNode(deps))
    .addEdge(START, "sendPoll")
    .addEdge("sendPoll", "waitForDecisionWindow")
    .addEdge("waitForDecisionWindow", "collectVotes")
    .addEdge("collectVotes", "bookSlots")
    .addConditionalEdges("bookSlots", (state: PipelineStateType) =>
      hasProposedBookings(state) ? "waitForGoConfirmation" : END,
    )
    .addEdge("waitForGoConfirmation", "announce")
    .addEdge("announce", END);

  return graph.compile({ checkpointer });
}

export type PipelineGraph = ReturnType<typeof buildPipelineGraph>;
