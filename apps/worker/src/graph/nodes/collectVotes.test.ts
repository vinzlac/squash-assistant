import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingRule } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

vi.mock("../resolveVotes.js", () => ({
  resolveVotes: vi.fn(async () => ({
    confirmedPlayerIdsByTime: { "18H45": ["u1", "u2"] },
    volunteerSubstituteIds: [],
    unresolvedNames: [],
  })),
}));

vi.mock("../../jobRuns.js", () => ({
  getJobRunById: vi.fn(async () => ({ pollMsgId: "poll-msg-1" })),
}));

vi.mock("../pinning.js", () => ({
  unpinBestEffort: vi.fn(async () => true),
}));

vi.mock("../../telegram/telegram.js", () => ({
  sendTelegramMessage: vi.fn(async () => {}),
}));

vi.mock("../emitEvent.js", () => ({
  withEventLogging: vi.fn(async (_deps, _event, action) => {
    const { result } = await action();
    return result;
  }),
}));

const { createCollectVotesNode } = await import("./collectVotes.js");
const { getJobRunById } = await import("../../jobRuns.js");
const { unpinBestEffort } = await import("../pinning.js");

const deps = {
  huddleBot: { client: {} as never, close: async () => {} },
  telegram: { botToken: "t", chatId: "c" },
  db: {} as never,
} as unknown as GraphDependencies;

function state(pinMessagesEnabled: boolean): PipelineStateType {
  return {
    bookingRule: {
      id: "test-rule",
      name: "Mardi",
      whatsappGroupJid: "group@test",
      candidateStartTimes: ["18H45"],
      pinMessagesEnabled,
    } as unknown as BookingRule,
    jobRunId: "job-1",
    targetDate: "2026-08-15",
    pollRequestId: "poll-1",
  } as PipelineStateType;
}

describe("createCollectVotesNode — épinglage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("désépingle le sondage après la collecte quand la règle l'active", async () => {
    const result = await createCollectVotesNode(deps)(state(true));

    expect(result.confirmedPlayerIdsByTime).toEqual({ "18H45": ["u1", "u2"] });
    expect(getJobRunById).toHaveBeenCalledWith(expect.anything(), "test-rule", "job-1");
    expect(unpinBestEffort).toHaveBeenCalledWith(expect.anything(), "Mardi", "group@test", "poll-msg-1", "du sondage");
  });

  it("ne touche à rien quand la règle ne l'active pas", async () => {
    await createCollectVotesNode(deps)(state(false));

    expect(unpinBestEffort).not.toHaveBeenCalled();
  });

  it("ne désépingle rien si le sondage n'a pas de msgId", async () => {
    vi.mocked(getJobRunById).mockResolvedValueOnce({ pollMsgId: null } as never);

    await createCollectVotesNode(deps)(state(true));

    expect(unpinBestEffort).not.toHaveBeenCalled();
  });
});
