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
vi.mock("../mcp/resaSquash.js", () => ({ listGroupMembers: vi.fn(), listMyFavorites: vi.fn() }));

const { getBookingRuleById } = await import("../bookingRules.js");
const { getJobRunById, cancelJobRun } = await import("../jobRuns.js");
const { deleteMessage } = await import("../mcp/huddleBot.js");
const { unpinRecapNow } = await import("../graph/pinning.js");
const { listGroupMembers, listMyFavorites } = await import("../mcp/resaSquash.js");
const { handleCancelPoll, handleFavorites, handleGroupMembers } = await import("./server.js");

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

describe("noms des joueurs pour l'UI admin — « Pseudo (Prénom NOM) »", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBookingRuleById).mockResolvedValue({ id: "rule-sam", resaSquashGroupId: "resa-1" } as never);
  });

  it("membres du groupe : pseudo puis nom complet (NOM en majuscules), prénom en guise de pseudo à défaut", async () => {
    const member = { group_id: "resa-1", licensee_id: "l", added_at: "2026-01-01", role: "member" };
    vi.mocked(listGroupMembers).mockResolvedValue({
      members: [
        { ...member, user_id: "vincent", first_name: "Vincent", last_name: "Lacoste", nickname: "Vince" },
        { ...member, user_id: "stephane", first_name: "Stéphane", last_name: "Martin" },
      ],
    });
    const res = fakeRes();

    await handleGroupMembers(res, deps, "rule-sam");

    expect(res.body).toEqual({ names: { vincent: "Vince (Vincent LACOSTE)", stephane: "Stéphane (Stéphane MARTIN)" } });
  });

  it("favoris : même format ; sans aucun nom, le userId", async () => {
    vi.mocked(listMyFavorites).mockResolvedValue({
      favorites: [
        { userId: "joshua", firstName: "Joshua", lastName: "Kupfer", nickname: "Josh" },
        { userId: "inconnu", firstName: null, lastName: null },
      ],
    });
    const res = fakeRes();

    await handleFavorites(res, deps);

    expect(res.body).toEqual({ names: { joshua: "Josh (Joshua KUPFER)", inconnu: "inconnu" } });
  });
});
