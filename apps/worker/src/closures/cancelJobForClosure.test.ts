import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../graph/dependencies.js";
import type { ClosureImpactEntry } from "./closureImpact.js";

vi.mock("../mcp/huddleBot.js", () => ({
  deleteMessage: vi.fn(async () => {}),
  unpinMessage: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => {}),
}));
vi.mock("../jobRuns.js", () => ({ cancelJobRun: vi.fn(async () => ({})) }));
vi.mock("../graph/pinning.js", () => ({ unpinRecapNow: vi.fn(async () => {}), unpinBestEffort: vi.fn(async () => true) }));
vi.mock("../graph/emitEvent.js", () => ({ emitEvent: vi.fn(async () => {}), findLastSuccessfulEvent: vi.fn(async () => undefined) }));
vi.mock("../roster/publishRoster.js", () => ({ withdrawRoster: vi.fn(async () => true) }));
vi.mock("../roster/rosterStore.js", () => ({ setPollUnpinnedAt: vi.fn(async () => {}) }));
vi.mock("../telegram/telegram.js", () => ({ sendTelegramMessage: vi.fn(async () => {}) }));

const { deleteMessage, sendMessage } = await import("../mcp/huddleBot.js");
const { cancelJobRun } = await import("../jobRuns.js");
const { unpinRecapNow, unpinBestEffort } = await import("../graph/pinning.js");
const { emitEvent, findLastSuccessfulEvent } = await import("../graph/emitEvent.js");
const { withdrawRoster } = await import("../roster/publishRoster.js");
const { setPollUnpinnedAt } = await import("../roster/rosterStore.js");
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

  it("sondage déjà supprimé à la collecte : pas de delete_message, « J'ai supprimé le sondage », récap désépinglé", async () => {
    const closedJob = job({ pollClosedAt: new Date("2026-09-14T07:00:00Z"), recapMsgId: "recap-1", recapJid: "g@test" });

    const result = await cancelJobForClosure(deps, rule, closedJob, entry, closure);

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(deps.huddleBot.client, "g@test", EXPECTED_MSG_DELETED);
    expect(vi.mocked(sendMessage).mock.calls[0]![2]).not.toContain("Ignorez le sondage");
    expect(unpinRecapNow).toHaveBeenCalledWith(deps, "Samedi", closedJob);
    expect(result).toEqual({ ok: true, jobId: "job-1", pollDeleted: true });
  });

  it("ordre nominal : delete_message → send_message → cancelJobRun → event success → Telegram", async () => {
    const calls: string[] = [];
    vi.mocked(deleteMessage).mockImplementation(async () => { calls.push("delete"); });
    vi.mocked(sendMessage).mockImplementation(async () => { calls.push("send"); return {}; });
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

  describe("job du roster vivant (roster_photo non nul)", () => {
    const sleep = vi.fn(async () => {});
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000);
    const liveJob = (overrides: Partial<JobRun> = {}) =>
      job({ rosterPhoto: {} as never, rosterJid: "roster@test", ruleSnapshot: { ...rule, pinMessagesEnabled: true } as never, ...overrides });

    beforeEach(() => {
      vi.mocked(unpinBestEffort).mockResolvedValue(true);
      vi.mocked(withdrawRoster).mockResolvedValue(true);
    });

    it("sondage < 48 h → supprimé, « J'ai supprimé le sondage », roster retiré", async () => {
      vi.mocked(findLastSuccessfulEvent).mockResolvedValue({ detail: {}, createdAt: hoursAgo(5) });

      const result = await cancelJobForClosure(deps, rule, liveJob(), entry, closure, { sleep });

      expect(findLastSuccessfulEvent).toHaveBeenCalledWith(deps.db, "job-1", "poll");
      expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, "g@test", "msg-1");
      expect(unpinBestEffort).not.toHaveBeenCalled();
      expect(setPollUnpinnedAt).toHaveBeenCalledWith(deps.db, "job-1", expect.any(Date));
      expect(withdrawRoster).toHaveBeenCalledWith(expect.objectContaining({ notifyJid: "roster@test", pinEnabled: true }));
      expect(sendMessage).toHaveBeenCalledWith(deps.huddleBot.client, "g@test", EXPECTED_MSG_DELETED);
      expect(result).toEqual({ ok: true, jobId: "job-1", pollDeleted: true });
    });

    it("ordre : cancelJobRun puis withdrawRoster, le sondage traité avant le message", async () => {
      vi.mocked(findLastSuccessfulEvent).mockResolvedValue({ detail: {}, createdAt: hoursAgo(5) });

      await cancelJobForClosure(deps, rule, liveJob(), entry, closure, { sleep });

      const order = (f: { mock: { invocationCallOrder: number[] } }) => f.mock.invocationCallOrder[0]!;
      expect(order(vi.mocked(deleteMessage))).toBeLessThan(order(vi.mocked(sendMessage)));
      expect(order(vi.mocked(cancelJobRun))).toBeLessThan(order(vi.mocked(withdrawRoster)));
    });

    it.each([
      ["< 48 h : suppression", 5],
      ["≥ 48 h : désépinglage", 72],
    ])("groupe de la copie de la règle (%s) : cible old@test, pas le groupe courant", async (_label, hours) => {
      vi.mocked(findLastSuccessfulEvent).mockResolvedValue({ detail: {}, createdAt: hoursAgo(hours) });
      const old = liveJob({ ruleSnapshot: { ...rule, whatsappGroupJid: "old@test", pinMessagesEnabled: true } as never });

      await cancelJobForClosure(deps, rule, old, entry, closure, { sleep });

      if (hours < 48) expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, "old@test", "msg-1");
      else expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "old@test", "msg-1", expect.any(String));
    });

    it("sondage ≥ 48 h → désépinglé, « Ignorez le sondage du coup », roster retiré", async () => {
      vi.mocked(findLastSuccessfulEvent).mockResolvedValue({ detail: {}, createdAt: hoursAgo(72) });

      const result = await cancelJobForClosure(deps, rule, liveJob(), entry, closure, { sleep });

      expect(deleteMessage).not.toHaveBeenCalled();
      expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "g@test", "msg-1", expect.any(String));
      expect(setPollUnpinnedAt).toHaveBeenCalled();
      expect(withdrawRoster).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(expect.anything(), "g@test", expect.stringContaining("Ignorez le sondage du coup"));
      expect(result).toEqual({ ok: true, jobId: "job-1", pollDeleted: false });
    });

    it("sondage < 48 h dont la suppression échoue → désépinglage, « Ignorez le sondage du coup »", async () => {
      vi.mocked(findLastSuccessfulEvent).mockResolvedValue({ detail: {}, createdAt: hoursAgo(5) });
      vi.mocked(deleteMessage).mockRejectedValue(new Error("boom"));

      const result = await cancelJobForClosure(deps, rule, liveJob(), entry, closure, { sleep });

      expect(unpinBestEffort).toHaveBeenCalled();
      expect(setPollUnpinnedAt).toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith(expect.anything(), "g@test", expect.stringContaining("Ignorez le sondage du coup"));
      expect(result).toEqual({ ok: true, jobId: "job-1", pollDeleted: false });
    });

    it("date du sondage inconnue → traité comme ≥ 48 h (pas de suppression)", async () => {
      vi.mocked(findLastSuccessfulEvent).mockResolvedValue(undefined);

      await cancelJobForClosure(deps, rule, liveJob(), entry, closure, { sleep });

      expect(deleteMessage).not.toHaveBeenCalled();
      expect(unpinBestEffort).toHaveBeenCalled();
    });

    it("suppression et désépinglage du sondage en échec → poll_unpinned_at non écrit", async () => {
      vi.mocked(findLastSuccessfulEvent).mockResolvedValue({ detail: {}, createdAt: hoursAgo(5) });
      vi.mocked(deleteMessage).mockRejectedValue(new Error("boom"));
      vi.mocked(unpinBestEffort).mockResolvedValue(false);

      const result = await cancelJobForClosure(deps, rule, liveJob(), entry, closure, { sleep });

      expect(setPollUnpinnedAt).not.toHaveBeenCalled();
      expect(cancelJobRun).toHaveBeenCalled();
      expect(result.pollDeleted).toBe(false);
    });

    it("la copie de la règle n'épingle pas et sondage non supprimé → pas d'appel huddle-bot, poll_unpinned_at écrit", async () => {
      vi.mocked(findLastSuccessfulEvent).mockResolvedValue({ detail: {}, createdAt: hoursAgo(72) });
      const noPin = liveJob({ ruleSnapshot: { ...rule, pinMessagesEnabled: false } as never });

      await cancelJobForClosure(deps, rule, noPin, entry, closure, { sleep });

      expect(unpinBestEffort).not.toHaveBeenCalled();
      expect(setPollUnpinnedAt).toHaveBeenCalled();
    });

    it("withdrawRoster pris 3 fois → Telegram, l'annulation va au bout", async () => {
      vi.mocked(findLastSuccessfulEvent).mockResolvedValue({ detail: {}, createdAt: hoursAgo(5) });
      vi.mocked(withdrawRoster).mockResolvedValue(false);

      const result = await cancelJobForClosure(deps, rule, liveJob(), entry, closure, { sleep });

      expect(withdrawRoster).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(sendTelegramMessage).toHaveBeenCalledWith(deps.telegram, expect.stringContaining("Roster non retiré"));
      expect(cancelJobRun).toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });

    it("withdrawRoster pris puis libre → deuxième essai suffit, pas de Telegram", async () => {
      vi.mocked(findLastSuccessfulEvent).mockResolvedValue({ detail: {}, createdAt: hoursAgo(5) });
      vi.mocked(withdrawRoster).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await cancelJobForClosure(deps, rule, liveJob(), entry, closure, { sleep });

      expect(withdrawRoster).toHaveBeenCalledTimes(2);
      expect(sendTelegramMessage).not.toHaveBeenCalledWith(deps.telegram, expect.stringContaining("Roster non retiré"));
    });
  });

  it("fermeture PUC legacy inchangée : ni findLastSuccessfulEvent ni withdrawRoster", async () => {
    const result = await cancelJobForClosure(deps, rule, job(), entry, closure);

    expect(findLastSuccessfulEvent).not.toHaveBeenCalled();
    expect(withdrawRoster).not.toHaveBeenCalled();
    expect(setPollUnpinnedAt).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, "g@test", "msg-1");
    expect(result).toEqual({ ok: true, jobId: "job-1", pollDeleted: true });
  });
});
