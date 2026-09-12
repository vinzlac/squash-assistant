import { describe, expect, it, vi } from "vitest";

vi.mock("../bookingRules.js", () => ({ loadBookingRules: vi.fn() }));
vi.mock("../jobRuns.js", () => ({ listJobRuns: vi.fn() }));
vi.mock("../scheduler/scheduler.js", () => ({ getJobExecutionStatus: vi.fn() }));

const { loadBookingRules } = await import("../bookingRules.js");
const { listJobRuns } = await import("../jobRuns.js");
const { getJobExecutionStatus } = await import("../scheduler/scheduler.js");
const { loadClosureImpact } = await import("./loadClosureImpact.js");

const wholeDay = { startsAt: new Date("2026-09-18T22:00:00Z"), endsAt: new Date("2026-09-19T22:00:00Z"), label: "tournoi" };
const now = new Date("2026-09-12T10:00:00Z");

describe("loadClosureImpact", () => {
  it("n'interroge LangGraph que pour les jobs dont la date cible est proche de l'intervalle", async () => {
    vi.mocked(loadBookingRules).mockResolvedValue([
      { id: "rule-sam", name: "Samedi", enabled: true, targetWeekday: 6, candidateStartTimes: ["18H45"] } as never,
    ]);
    vi.mocked(listJobRuns).mockResolvedValue([
      { id: "old", bookingRuleId: "rule-sam", targetDate: "2026-06-06", cancelledAt: null, candidateStartTimes: null } as never,
      { id: "j19", bookingRuleId: "rule-sam", targetDate: "2026-09-19", cancelledAt: null, candidateStartTimes: null } as never,
      { id: "cancelled", bookingRuleId: "rule-sam", targetDate: "2026-09-19", cancelledAt: new Date(), candidateStartTimes: null } as never,
    ]);
    vi.mocked(getJobExecutionStatus).mockResolvedValue({ stage: "awaiting-decision" } as never);

    const impact = await loadClosureImpact({ db: {} as never, graph: {} as never }, wholeDay, now);

    expect(getJobExecutionStatus).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getJobExecutionStatus).mock.calls[0]![1]).toMatchObject({ id: "j19" });
    expect(impact.running.map((e) => e.jobId)).toEqual(["j19"]);
  });
});
