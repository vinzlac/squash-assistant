import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../graph/dependencies.js";
import type { ClosureImpactEntry } from "./closureImpact.js";

vi.mock("../mcp/huddleBot.js", () => ({
  deleteMessage: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => {}),
}));
vi.mock("../jobRuns.js", () => ({ cancelJobRun: vi.fn(async () => ({})) }));
vi.mock("../graph/emitEvent.js", () => ({ emitEvent: vi.fn(async () => {}) }));
vi.mock("../telegram/telegram.js", () => ({ sendTelegramMessage: vi.fn(async () => {}) }));

const { deleteMessage, sendMessage } = await import("../mcp/huddleBot.js");
const { cancelJobRun } = await import("../jobRuns.js");
const { emitEvent } = await import("../graph/emitEvent.js");
const { sendTelegramMessage } = await import("../telegram/telegram.js");
const { cancelJobForClosure } = await import("./cancelJobForClosure.js");

const rule = { id: "rule-sam", name: "Samedi", whatsappGroupJid: "g@test" } as BookingRule;
function job(overrides: Partial<JobRun> = {}): JobRun {
  return { id: "job-1", bookingRuleId: "rule-sam", targetDate: "2026-09-19", pollMsgId: "msg-1", ...overrides } as JobRun;
}
const entry: ClosureImpactEntry = {
  ruleId: "rule-sam",
  ruleLabel: "Samedi",
  jobId: "job-1",
  targetDate: "2026-09-19",
  stage: "awaiting-decision",
  closedTimes: ["18H45", "19H30"],
};
const closure = { id: "closure-1", label: "tournoi" };
const deps = {
  huddleBot: { client: {} as never, close: async () => {} },
  resaSquash: { client: {} as never, close: async () => {} },
  telegram: { botToken: "t", chatId: "c" },
  db: {} as never,
} as GraphDependencies;

const EXPECTED_MSG_DELETED =
  "Hello la team ! Mauvaise nouvelle : le PUC est fermé samedi 19 septembre (tournoi), donc pas de squash ce jour-là 😕 J'ai supprimé le sondage, on remet ça la semaine prochaine 💪";

describe("cancelJobForClosure", () => {
  beforeEach(() => vi.resetAllMocks());

  it("ordre nominal : delete_message → send_message → cancelJobRun → event success → Telegram", async () => {
    const calls: string[] = [];
    vi.mocked(deleteMessage).mockImplementation(async () => { calls.push("delete"); });
    vi.mocked(sendMessage).mockImplementation(async () => { calls.push("send"); });
    vi.mocked(cancelJobRun).mockImplementation(async () => { calls.push("cancel"); return {} as never; });
    vi.mocked(emitEvent).mockImplementation(async () => { calls.push("event"); });
    vi.mocked(sendTelegramMessage).mockImplementation(async () => { calls.push("telegram"); });

    const result = await cancelJobForClosure(deps, rule, job(), entry, closure);

    expect(result).toEqual({ ok: true, jobId: "job-1", pollDeleted: true });
    expect(calls).toEqual(["delete", "send", "cancel", "event", "telegram"]);
    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, "g@test", "msg-1");
    expect(sendMessage).toHaveBeenCalledWith(deps.huddleBot.client, "g@test", EXPECTED_MSG_DELETED);
    expect(cancelJobRun).toHaveBeenCalledWith(deps.db, "job-1", { reason: "PUC fermé : tournoi", clubClosureId: "closure-1" });
    expect(emitEvent).toHaveBeenCalledWith(deps.db, {
      bookingRuleId: "rule-sam",
      jobRunId: "job-1",
      type: "club-closed",
      status: "success",
      targetDate: "2026-09-19",
      detail: { closureId: "closure-1", label: "tournoi", stage: "awaiting-decision", pollDeleted: true, message: EXPECTED_MSG_DELETED, closedTimes: ["18H45", "19H30"] },
    });
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      deps.telegram,
      "[rule-sam] PUC fermé le 2026-09-19 (tournoi) — job job-1 arrêté à l'étape awaiting-decision, sondage supprimé : oui",
    );
  });

  it("pollMsgId absent : pas de delete, message « ignorez le sondage », pollDeleted false", async () => {
    const result = await cancelJobForClosure(deps, rule, job({ pollMsgId: null }), entry, closure);

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.anything(), "g@test", expect.stringContaining("Ignorez le sondage du coup"));
    expect(result).toEqual({ ok: true, jobId: "job-1", pollDeleted: false });
  });

  it("delete_message en échec : non bloquant, pollDeleted false", async () => {
    vi.mocked(deleteMessage).mockRejectedValue(new Error("boom"));

    const result = await cancelJobForClosure(deps, rule, job(), entry, closure);

    expect(sendMessage).toHaveBeenCalled();
    expect(cancelJobRun).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, jobId: "job-1", pollDeleted: false });
    expect(sendTelegramMessage).toHaveBeenCalledWith(deps.telegram, expect.stringContaining("sondage supprimé : non"));
  });

  it("send_message en échec : job quand même annulé, event error, résultat ok:false", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new Error("whatsapp down"));

    const result = await cancelJobForClosure(deps, rule, job(), entry, closure);

    expect(cancelJobRun).toHaveBeenCalledWith(deps.db, "job-1", { reason: "PUC fermé : tournoi", clubClosureId: "closure-1" });
    expect(emitEvent).toHaveBeenCalledWith(deps.db, expect.objectContaining({ status: "error", detail: expect.objectContaining({ error: "whatsapp down", step: "send_message" }) }));
    expect(result).toEqual({ ok: false, jobId: "job-1", error: "whatsapp down", pollDeleted: true });
  });

  it("sans libellé : raison générique", async () => {
    await cancelJobForClosure(deps, rule, job(), entry, { id: "closure-1", label: null });
    expect(cancelJobRun).toHaveBeenCalledWith(deps.db, "job-1", { reason: "PUC fermé", clubClosureId: "closure-1" });
  });
});
