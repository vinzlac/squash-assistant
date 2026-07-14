import { Annotation } from "@langchain/langgraph";
import type { GroupConfig } from "../config.js";
import type { GroupBookingPlan } from "../mcp/resaSquash.js";

export const PipelineState = Annotation.Root({
  groupConfig: Annotation<GroupConfig>(),
  targetDate: Annotation<string>(),
  pollRequestId: Annotation<string | undefined>(),
  confirmedPlayerIds: Annotation<string[]>(),
  bookingPlan: Annotation<GroupBookingPlan | undefined>(),
  goConfirmed: Annotation<boolean>(),
});

export type PipelineStateType = typeof PipelineState.State;
