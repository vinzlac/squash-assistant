import { Annotation } from "@langchain/langgraph";
import type { BookingRule } from "../config.js";
import type { GroupBookingPlan } from "../mcp/resaSquash.js";

export const PipelineState = Annotation.Root({
  bookingRule: Annotation<BookingRule>(),
  jobRunId: Annotation<string>(),
  targetDate: Annotation<string>(),
  pollRequestId: Annotation<string | undefined>(),
  confirmedPlayerIds: Annotation<string[]>(),
  bookingPlan: Annotation<GroupBookingPlan | undefined>(),
  goConfirmed: Annotation<boolean>(),
});

export type PipelineStateType = typeof PipelineState.State;
