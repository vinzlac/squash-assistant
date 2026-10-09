import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";

vi.mock("../bookingRules.js", () => ({ getBookingRuleById: vi.fn() }));
vi.mock("../jobRuns.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jobRuns.js")>()),
  getJobRunById: vi.fn(),
  cancelJobRun: vi.fn(async () => ({})),
}));
vi.mock("../mcp/huddleBot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp/huddleBot.js")>()),
  deleteMessage: vi.fn(async () => {}),
}));
vi.mock("../graph/pinning.js", () => ({ unpinRecapNow: vi.fn(async () => {}) }));

const { getBookingRuleById } = await import("../bookingRules.js");
const { getJobRunById, cancelJobRun } = await import("../jobRuns.js");
const { deleteMessage } = await import("../mcp/huddleBot.js");
const { unpinRecapNow } = await import("../graph/pinning.js");
const { handleCancelPoll } = await import("./server.js");

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, writeHead: vi.fn(), end: vi.fn() };
  res.writeHead.mockImplementation((code: number) => { res.statusCode = code; });
  res.end.mockImplementation((raw: string) => { res.body = JSON.parse(raw); });
  return res as unknown as ServerResponse & { statusCode: number; body: unknown };
}

const deps = {
  db: {} as never,
  graph: {} as never,
  telegram: { botToken: "t", chatId: "c" },
  huddleBot: { client: {} as never, close: async () => {} },
  resaSquash: { client: {} as never, close: async () => {} },
};

describe("handleCancelPoll (spec 2026-10-09 §1.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBookingRuleById).mockResolvedValue({ id: "rule-sam", name: "Samedi", whatsappGroupJid: "g@test" } as never);
  });

  it("refusé (409) si le sondage a été clôturé à la collecte", async () => {
    vi.mocked(getJobRunById).mockResolvedValue({ id: "job-1", pollMsgId: "msg-1", pollClosedAt: new Date() } as never);
    const res = fakeRes();

    await handleCancelPoll(res, deps, "rule-sam", "job-1");

    expect(res.statusCode).toBe(409);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(cancelJobRun).not.toHaveBeenCalled();
  });

  it("sondage non clôturé (mode test) : suppression, annulation, récap désépinglé", async () => {
    const job = { id: "job-1", pollMsgId: "msg-1", pollClosedAt: null, recapMsgId: "recap-1", recapJid: "test@g.us" };
    vi.mocked(getJobRunById).mockResolvedValue(job as never);
    const res = fakeRes();

    await handleCancelPoll(res, deps, "rule-sam", "job-1");

    expect(res.statusCode).toBe(200);
    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, "g@test", "msg-1");
    expect(cancelJobRun).toHaveBeenCalledWith(deps.db, "job-1");
    expect(unpinRecapNow).toHaveBeenCalledWith(deps, "Samedi", job);
  });
});
