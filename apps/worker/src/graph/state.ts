import { Annotation } from "@langchain/langgraph";
import type { BookingRule } from "../config.js";
import type { GroupBookingPlan } from "../mcp/resaSquash.js";

/** Le plan de réservation pour une heure candidate donnée (un appel plan_group_bookings par heure — voir ADR-013). */
export interface BookingPlanGroup {
  startTime: string;
  plan: GroupBookingPlan;
}

export const PipelineState = Annotation.Root({
  bookingRule: Annotation<BookingRule>(),
  jobRunId: Annotation<string>(),
  targetDate: Annotation<string>(),
  pollRequestId: Annotation<string | undefined>(),
  confirmedPlayerIdsByTime: Annotation<Record<string, string[]>>(),
  bookingPlanGroups: Annotation<BookingPlanGroup[] | undefined>(),
  goConfirmed: Annotation<boolean>(),
  announceMessage: Annotation<string | undefined>(),
});

export type PipelineStateType = typeof PipelineState.State;
