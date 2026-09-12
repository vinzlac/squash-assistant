import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";

vi.mock("../closures/loadClosureImpact.js", () => ({ loadClosureImpact: vi.fn() }));
vi.mock("../closures/cancelJobForClosure.js", () => ({ cancelJobForClosure: vi.fn() }));
vi.mock("../bookingRules.js", () => ({ getBookingRuleById: vi.fn() }));
vi.mock("../jobRuns.js", () => ({ getJobRunById: vi.fn() }));

const { loadClosureImpact } = await import("../closures/loadClosureImpact.js");
const { cancelJobForClosure } = await import("../closures/cancelJobForClosure.js");
const { getBookingRuleById } = await import("../bookingRules.js");
const { getJobRunById } = await import("../jobRuns.js");
const { handleClubClosureCreate, handleClubClosurePreview, parseClosureInterval } = await import("./clubClosuresHandlers.js");

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, writeHead: vi.fn(), end: vi.fn() };
  res.writeHead.mockImplementation((code: number) => { res.statusCode = code; });
  res.end.mockImplementation((raw: string) => { res.body = JSON.parse(raw); });
  return res as unknown as ServerResponse & { statusCode: number; body: unknown };
}

function deps(insertedId = "closure-1") {
  const insert = vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: insertedId }]) })) }));
  return { db: { insert } as never, graph: {} as never, telegram: { botToken: "t", chatId: "c" }, huddleBot: { client: {} as never, close: async () => {} }, resaSquash: { client: {} as never, close: async () => {} }, insert };
}

const runningEntry = { ruleId: "rule-sam", ruleLabel: "Samedi", jobId: "job-1", targetDate: "2026-09-19", stage: "awaiting-decision" as const, closedTimes: ["18H45"] };
const validBody = { startsAt: "2026-09-18T22:00:00.000Z", endsAt: "2026-09-19T22:00:00.000Z", label: "tournoi" };

describe("parseClosureInterval", () => {
  it("refuse endsAt <= startsAt", () => {
    expect(parseClosureInterval({ startsAt: validBody.endsAt, endsAt: validBody.startsAt })).toEqual({ ok: false, error: "La fin doit être après le début." });
  });
  it("refuse une date invalide", () => {
    expect(parseClosureInterval({ startsAt: "nope", endsAt: validBody.endsAt }).ok).toBe(false);
  });
});

describe("handleClubClosurePreview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renvoie l'impact sans rien écrire", async () => {
    vi.mocked(loadClosureImpact).mockResolvedValue({ running: [runningEntry], planned: [], errored: [] });
    const res = fakeRes();
    const d = deps();

    await handleClubClosurePreview(res, d, validBody);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ running: [runningEntry], planned: [], errored: [] });
    expect(d.insert).not.toHaveBeenCalled();
    expect(cancelJobForClosure).not.toHaveBeenCalled();
  });

  it("400 sur bornes invalides", async () => {
    const res = fakeRes();
    await handleClubClosurePreview(res, deps(), { startsAt: "x", endsAt: "y" });
    expect(res.statusCode).toBe(400);
  });
});

describe("handleClubClosureCreate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("400 si libellé vide, rien n'est inséré", async () => {
    const res = fakeRes();
    const d = deps();
    await handleClubClosureCreate(res, d, { ...validBody, label: "  " });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Le libellé (raison de la fermeture) est obligatoire." });
    expect(d.insert).not.toHaveBeenCalled();
  });

  it("insère, recalcule l'impact et arrête chaque job en cours", async () => {
    vi.mocked(loadClosureImpact).mockResolvedValue({ running: [runningEntry], planned: [], errored: [] });
    vi.mocked(getBookingRuleById).mockResolvedValue({ id: "rule-sam" } as never);
    vi.mocked(getJobRunById).mockResolvedValue({ id: "job-1" } as never);
    vi.mocked(cancelJobForClosure).mockResolvedValue({ ok: true, jobId: "job-1", pollDeleted: true });
    const res = fakeRes();
    const d = deps();

    await handleClubClosureCreate(res, d, validBody);

    expect(d.insert).toHaveBeenCalledTimes(1);
    expect(cancelJobForClosure).toHaveBeenCalledWith(
      expect.objectContaining({ db: d.db }),
      { id: "rule-sam" },
      { id: "job-1" },
      runningEntry,
      { id: "closure-1", label: "tournoi" },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ closureId: "closure-1", cancelled: [runningEntry], failed: [], planned: [], errored: [] });
  });

  it("un échec de cascade n'empêche pas les autres et remonte dans failed", async () => {
    const second = { ...runningEntry, jobId: "job-2", ruleId: "rule-dim" };
    vi.mocked(loadClosureImpact).mockResolvedValue({ running: [runningEntry, second], planned: [], errored: [] });
    vi.mocked(getBookingRuleById).mockImplementation(async (_db, id) => ({ id }) as never);
    vi.mocked(getJobRunById).mockImplementation(async (_db, _ruleId, id) => ({ id }) as never);
    vi.mocked(cancelJobForClosure)
      .mockResolvedValueOnce({ ok: false, jobId: "job-1", error: "whatsapp down", pollDeleted: true })
      .mockResolvedValueOnce({ ok: true, jobId: "job-2", pollDeleted: true });
    const res = fakeRes();

    await handleClubClosureCreate(res, deps(), validBody);

    expect(res.body).toEqual({
      closureId: "closure-1",
      cancelled: [second],
      failed: [{ jobId: "job-1", ruleId: "rule-sam", error: "whatsapp down" }],
      planned: [],
      errored: [],
    });
  });

  it("un throw de cascade n'empêche pas les autres et remonte dans failed", async () => {
    const second = { ...runningEntry, jobId: "job-2", ruleId: "rule-dim" };
    vi.mocked(loadClosureImpact).mockResolvedValue({ running: [runningEntry, second], planned: [], errored: [] });
    vi.mocked(getBookingRuleById).mockImplementation(async (_db, id) => ({ id }) as never);
    vi.mocked(getJobRunById).mockImplementation(async (_db, _ruleId, id) => ({ id }) as never);
    vi.mocked(cancelJobForClosure)
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ ok: true, jobId: "job-2", pollDeleted: true });
    const res = fakeRes();

    await handleClubClosureCreate(res, deps(), validBody);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      closureId: "closure-1",
      cancelled: [second],
      failed: [{ jobId: "job-1", ruleId: "rule-sam", error: "db down" }],
      planned: [],
      errored: [],
    });
  });

  it("si le calcul d'impact échoue après l'insert → 200 avec closureId + cascadeError (pas de 500, pas de doublon)", async () => {
    vi.mocked(loadClosureImpact).mockRejectedValue(new Error("MCP resa-squash injoignable"));
    const res = fakeRes();
    const d = deps();

    await handleClubClosureCreate(res, d, validBody);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      closureId: "closure-1",
      cancelled: [],
      failed: [],
      planned: [],
      errored: [],
      cascadeError: "MCP resa-squash injoignable",
    });
    expect(d.insert).toHaveBeenCalledTimes(1);
    expect(cancelJobForClosure).not.toHaveBeenCalled();
  });

  it("si l'insert échoue → 500 et aucune cascade", async () => {
    const res = fakeRes();
    const d = deps();
    d.insert.mockImplementation(() => { throw new Error("insert failed"); });

    await handleClubClosureCreate(res, d, validBody);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "insert failed" });
    expect(loadClosureImpact).not.toHaveBeenCalled();
  });
});
