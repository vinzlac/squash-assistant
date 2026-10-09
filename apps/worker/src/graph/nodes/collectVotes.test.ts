import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType, UnresolvedVoter } from "../state.js";

vi.mock("../resolveVotes.js", () => ({ resolveVotes: vi.fn() }));
vi.mock("../../jobRuns.js", () => ({
  getJobRunById: vi.fn(),
  setJobRunPollClosedAt: vi.fn(),
  setJobRunRecapInfo: vi.fn(),
}));
vi.mock("../../mcp/huddleBot.js", () => ({ deleteMessage: vi.fn(), sendMessage: vi.fn() }));
vi.mock("../pinning.js", () => ({ pinBestEffort: vi.fn(), unpinBestEffort: vi.fn() }));
vi.mock("../../telegram/telegram.js", () => ({ sendTelegramMessage: vi.fn() }));
vi.mock("../emitEvent.js", () => ({
  withEventLogging: vi.fn(async (_deps, _event, action) => (await action()).result),
  findLastSuccessfulEventDetail: vi.fn(),
}));
vi.mock("./announce.js", () => ({ resolveAnnounceNotifyJid: vi.fn() }));

const { createCollectVotesNode } = await import("./collectVotes.js");
const { resolveVotes } = await import("../resolveVotes.js");
const { getJobRunById, setJobRunPollClosedAt, setJobRunRecapInfo } = await import("../../jobRuns.js");
const { deleteMessage, sendMessage } = await import("../../mcp/huddleBot.js");
const { pinBestEffort, unpinBestEffort } = await import("../pinning.js");
const { sendTelegramMessage } = await import("../../telegram/telegram.js");
const { findLastSuccessfulEventDetail } = await import("../emitEvent.js");
const { resolveAnnounceNotifyJid } = await import("./announce.js");

const deps = {
  huddleBot: { client: {} as never, close: async () => {} },
  resaSquash: { client: {} as never, close: async () => {} },
  telegram: { botToken: "t", chatId: "c" },
  db: {} as never,
} as unknown as GraphDependencies;

const VOTES = {
  confirmedPlayerIdsByTime: { "10H30": ["u1", "u2"] },
  volunteerSubstituteIds: [] as string[],
  unresolvedVoters: [] as UnresolvedVoter[],
  voterNames: { u1: "Hugo MERCIER", u2: "Vincent LACOSTE" } as Record<string, string>,
};
const QUESTION_WITH_CLOSURE = "Squash samedi 10 octobre à 10h30 ? (réponses jusqu'au lundi 5 octobre à 9h)";

function job(overrides: Partial<JobRun> = {}): JobRun {
  return { id: "job-1", bookingRuleId: "test-rule", targetDate: "2026-10-10", pollMsgId: "poll-msg-1", pollClosedAt: null, ...overrides } as JobRun;
}

/** Événements du job : `poll` (texte envoyé) et `collect_votes` (votes déjà lus). */
function events(poll: { question: string } | undefined, collect: unknown = undefined): void {
  vi.mocked(findLastSuccessfulEventDetail).mockImplementation(async (_db, _jobRunId, type) =>
    type === "poll" ? poll : type === "collect_votes" ? collect : undefined,
  );
}

function state(pinMessagesEnabled = false): PipelineStateType {
  return {
    bookingRule: {
      id: "test-rule",
      name: "Samedi",
      whatsappGroupJid: "group@test",
      resaSquashGroupId: "resa-1",
      candidateStartTimes: ["10H30"],
      pinMessagesEnabled,
    } as unknown as BookingRule,
    jobRunId: "job-1",
    targetDate: "2026-10-10",
    pollRequestId: "poll-1",
  } as PipelineStateType;
}

const telegramTexts = () => vi.mocked(sendTelegramMessage).mock.calls.map((c) => String(c[1]));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveVotes).mockResolvedValue(VOTES);
  vi.mocked(getJobRunById).mockResolvedValue(job());
  vi.mocked(setJobRunPollClosedAt).mockResolvedValue(undefined);
  vi.mocked(setJobRunRecapInfo).mockResolvedValue(undefined);
  vi.mocked(deleteMessage).mockResolvedValue(undefined);
  vi.mocked(sendMessage).mockResolvedValue({ msgId: "recap-1" });
  vi.mocked(pinBestEffort).mockResolvedValue(undefined);
  vi.mocked(unpinBestEffort).mockResolvedValue(true);
  vi.mocked(sendTelegramMessage).mockResolvedValue(undefined);
  vi.mocked(resolveAnnounceNotifyJid).mockResolvedValue("group@test");
  events({ question: QUESTION_WITH_CLOSURE });
});

describe("createCollectVotesNode — clôture du sondage (spec 2026-10-09 §1.2)", () => {
  it("ordre : lecture → poll_closed_at → suppression → messages", async () => {
    const calls: string[] = [];
    vi.mocked(resolveVotes).mockImplementation(async () => { calls.push("read"); return VOTES; });
    vi.mocked(setJobRunPollClosedAt).mockImplementation(async () => { calls.push("closed"); });
    vi.mocked(deleteMessage).mockImplementation(async () => { calls.push("delete"); });
    vi.mocked(sendTelegramMessage).mockImplementation(async () => { calls.push("telegram"); });
    vi.mocked(sendMessage).mockImplementation(async () => { calls.push("recap"); return { msgId: "recap-1" }; });

    const result = await createCollectVotesNode(deps)(state());

    expect(calls).toEqual(["read", "closed", "delete", "telegram", "recap"]);
    expect(setJobRunPollClosedAt).toHaveBeenCalledWith(deps.db, "job-1", expect.any(Date));
    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, "group@test", "poll-msg-1");
    expect(result).toEqual(VOTES);
  });

  it("lecture en échec : rien n'est clôturé ni supprimé, l'étape échoue", async () => {
    vi.mocked(resolveVotes).mockRejectedValue(new Error("huddle-bot down"));

    await expect(createCollectVotesNode(deps)(state(true))).rejects.toThrow("huddle-bot down");
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("suppression en échec : poll_closed_at écrit puis remis à null, Telegram, désépinglage tenté, étape réussie", async () => {
    vi.mocked(deleteMessage).mockRejectedValue(new Error("boom"));

    const result = await createCollectVotesNode(deps)(state(true));

    expect(result).toEqual(VOTES);
    expect(vi.mocked(setJobRunPollClosedAt).mock.calls).toEqual([
      [deps.db, "job-1", expect.any(Date)],
      [deps.db, "job-1", null],
    ]);
    expect(telegramTexts()).toContain("[Samedi] Suppression du sondage échouée : boom");
    expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "poll-msg-1", "du sondage");
  });

  it("écriture initiale de poll_closed_at en échec : pas de suppression, Telegram, désépinglage, étape réussie", async () => {
    vi.mocked(setJobRunPollClosedAt).mockRejectedValue(new Error("pg down"));

    const result = await createCollectVotesNode(deps)(state(true));

    expect(result).toEqual(VOTES);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(telegramTexts().some((t) => t.startsWith("[Samedi] Sondage non supprimé : clôture non enregistrée") && t.includes("pg down"))).toBe(true);
    expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "poll-msg-1", "du sondage");
  });

  it("pollMsgId inconnu : pas de suppression, Telegram « msgId inconnu », poll_closed_at non écrit", async () => {
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollMsgId: null }));

    await createCollectVotesNode(deps)(state());

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
    expect(telegramTexts()).toContain("[Samedi] Sondage non supprimé : msgId inconnu.");
  });

  it("sondage supprimé : pas de désépinglage explicite (il part avec le message)", async () => {
    await createCollectVotesNode(deps)(state(true));
    expect(unpinBestEffort).not.toHaveBeenCalled();
  });

  it("Telegram et récap en échec après suppression : étape réussie", async () => {
    vi.mocked(sendTelegramMessage).mockRejectedValue(new Error("telegram down"));
    vi.mocked(sendMessage).mockRejectedValue(new Error("whatsapp down"));

    await expect(createCollectVotesNode(deps)(state())).resolves.toEqual(VOTES);
  });

  it("relance avec poll_closed_at (pod tué après la clôture) : votes repris de l'événement collect_votes, get_responses jamais appelé", async () => {
    const voter = { name: "Vince", phone: "+33663892186", option: "Non, mais je peux prêter mon nom" };
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollClosedAt: new Date("2026-10-05T07:00:00Z") }));
    events({ question: QUESTION_WITH_CLOSURE }, { pollRequestId: "poll-1", ...VOTES, unresolvedVoters: [voter] });

    const result = await createCollectVotesNode(deps)(state());

    expect(findLastSuccessfulEventDetail).toHaveBeenCalledWith(deps.db, "job-1", "collect_votes");
    expect(resolveVotes).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ ...VOTES, unresolvedVoters: [voter] });
  });

  it("relance avec poll_closed_at sans événement : échec explicite", async () => {
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollClosedAt: new Date() }));
    events({ question: QUESTION_WITH_CLOSURE }, undefined);

    await expect(createCollectVotesNode(deps)(state())).rejects.toThrow("sondage fermé, votes introuvables");
    expect(resolveVotes).not.toHaveBeenCalled();
  });

  it("sondage sans mention « réponses jusqu'au » (ancien sondage ou mention omise) : pas de suppression, désépinglage seul", async () => {
    events({ question: "Squash samedi 10 octobre à 10h30 ?" });

    await createCollectVotesNode(deps)(state(true));

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
    expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "poll-msg-1", "du sondage");
  });

  it("mode test (annonce ≠ sondage) : pas de suppression, désépinglage seul, récap sur le groupe test", async () => {
    vi.mocked(resolveAnnounceNotifyJid).mockResolvedValue("test@g.us");

    await createCollectVotesNode(deps)(state(true));

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
    expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "poll-msg-1", "du sondage");
    expect(sendMessage).toHaveBeenCalledWith(deps.huddleBot.client, "test@g.us", expect.stringContaining("🔒 Inscriptions closes"));
  });
});

describe("createCollectVotesNode — messages (spec 2026-10-09 §2, §3)", () => {
  it("récap au groupe de l'annonce avec les noms de voterNames, épinglé et mémorisé si la règle l'active", async () => {
    await createCollectVotesNode(deps)(state(true));

    expect(sendMessage).toHaveBeenCalledWith(
      deps.huddleBot.client,
      "group@test",
      "🔒 Inscriptions closes — samedi 10 octobre 🎾\n⏰ 10h30 (2) : Hugo MERCIER, Vincent LACOSTE\nLes courts arrivent bientôt 😉",
    );
    expect(pinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "recap-1", "du récap");
    expect(setJobRunRecapInfo).toHaveBeenCalledWith(deps.db, "job-1", { msgId: "recap-1", jid: "group@test" });
  });

  it("épinglage désactivé : récap envoyé, ni épinglé ni mémorisé", async () => {
    await createCollectVotesNode(deps)(state(false));

    expect(sendMessage).toHaveBeenCalled();
    expect(pinBestEffort).not.toHaveBeenCalled();
    expect(setJobRunRecapInfo).not.toHaveBeenCalled();
  });

  it("Telegram : « Confirmés par heure » puis non-identifiés, avant le récap", async () => {
    const voter = { name: "Vince", phone: "+33663892186", option: "Non, mais je peux prêter mon nom" };
    vi.mocked(resolveVotes).mockResolvedValue({ ...VOTES, unresolvedVoters: [voter] });

    await createCollectVotesNode(deps)(state());

    expect(telegramTexts()[0]).toBe("[Samedi] Confirmés par heure — 10H30 : 2.");
    expect(telegramTexts()[1]).toContain("[Samedi] ⚠️ 1 votant(s) non identifié(s)");
    expect(vi.mocked(sendTelegramMessage).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(sendMessage).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(sendMessage).mock.calls[0]![2]).toContain("🙏 Merci à Vince pour le prête-nom :)");
  });

  it("récap en échec : signalé sur Telegram", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new Error("whatsapp down"));

    await createCollectVotesNode(deps)(state());

    expect(telegramTexts()).toContain("[Samedi] Récap des inscrits non envoyé : whatsapp down");
  });
});
