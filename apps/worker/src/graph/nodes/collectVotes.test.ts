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
  findLastSuccessfulEvent: vi.fn(),
  emitEvent: vi.fn(),
}));
vi.mock("./announce.js", () => ({ resolveAnnounceNotifyJid: vi.fn() }));

const { createCollectVotesNode } = await import("./collectVotes.js");
const { resolveVotes } = await import("../resolveVotes.js");
const { getJobRunById, setJobRunPollClosedAt, setJobRunRecapInfo } = await import("../../jobRuns.js");
const { deleteMessage, sendMessage } = await import("../../mcp/huddleBot.js");
const { pinBestEffort, unpinBestEffort } = await import("../pinning.js");
const { sendTelegramMessage } = await import("../../telegram/telegram.js");
const { findLastSuccessfulEventDetail, findLastSuccessfulEvent, emitEvent } = await import("../emitEvent.js");
const { resolveAnnounceNotifyJid } = await import("./announce.js");
const { withEventLogging } = await import("../emitEvent.js");
const actualEmitEvent = await vi.importActual<typeof import("../emitEvent.js")>("../emitEvent.js");

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
/** Lecture du sondage : VOTES + nombre de membres ayant répondu quoi que ce soit (resolveVotes). */
const READ = { ...VOTES, respondentCount: 2 };
const CONFIRMED = "[Samedi] Confirmés par heure — 10H30 : 2.";
const QUESTION_WITH_CLOSURE = "Squash samedi 10 octobre à 10h30 ? (réponses jusqu'au lundi 5 octobre à 9h)";

function job(overrides: Partial<JobRun> = {}): JobRun {
  return { id: "job-1", bookingRuleId: "test-rule", targetDate: "2026-10-10", pollMsgId: "poll-msg-1", pollClosedAt: null, ...overrides } as JobRun;
}

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS);

/**
 * Événements du job : `poll` (texte envoyé, envoyé il y a `pollAgeHours` h ; `null` = date absente)
 * , `collect_votes` (votes déjà lus) et `poll_deleted` (suppression déjà réussie) si `pollDeleted`.
 */
function events(
  poll: { question: string } | undefined,
  collect: unknown = undefined,
  pollAgeHours: number | null = 1,
  pollDeleted = false,
): void {
  const detailOf = (type: string) =>
    type === "poll"
      ? poll
      : type === "collect_votes"
        ? collect
        : type === "poll_deleted" && pollDeleted
          ? { pollMsgId: "poll-msg-1" }
          : undefined;
  vi.mocked(findLastSuccessfulEventDetail).mockImplementation(async (_db, _jobRunId, type) => detailOf(type));
  vi.mocked(findLastSuccessfulEvent).mockImplementation(async (_db, _jobRunId, type) => {
    const detail = detailOf(type);
    if (detail === undefined) return undefined;
    const createdAt = type === "poll" && pollAgeHours === null ? null : hoursAgo(type === "poll" ? pollAgeHours ?? 0 : 0);
    return { detail, createdAt };
  });
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
  vi.mocked(resolveVotes).mockResolvedValue(READ);
  vi.mocked(getJobRunById).mockResolvedValue(job());
  vi.mocked(setJobRunPollClosedAt).mockResolvedValue(undefined);
  vi.mocked(setJobRunRecapInfo).mockResolvedValue(undefined);
  vi.mocked(deleteMessage).mockResolvedValue(undefined);
  vi.mocked(sendMessage).mockResolvedValue({ msgId: "recap-1" });
  vi.mocked(pinBestEffort).mockResolvedValue(true);
  vi.mocked(unpinBestEffort).mockResolvedValue(true);
  vi.mocked(sendTelegramMessage).mockResolvedValue(undefined);
  vi.mocked(emitEvent).mockResolvedValue(undefined);
  vi.mocked(resolveAnnounceNotifyJid).mockResolvedValue("group@test");
  events({ question: QUESTION_WITH_CLOSURE });
});

describe("createCollectVotesNode — clôture du sondage (spec 2026-10-09 §1.2)", () => {
  it("ordre : lecture → poll_closed_at → suppression → messages", async () => {
    const calls: string[] = [];
    vi.mocked(resolveVotes).mockImplementation(async () => { calls.push("read"); return READ; });
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
    expect(result).toEqual({ ...VOTES, unresolvedVoters: [voter] });
  });

  it("relance après clôture, suppression retentée et réussie : poll_deleted écrit, Telegram de collecte renvoyé, aucun WhatsApp", async () => {
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollClosedAt: new Date("2026-10-05T07:00:00Z") }));
    events({ question: QUESTION_WITH_CLOSURE }, { pollRequestId: "poll-1", ...VOTES });

    await expect(createCollectVotesNode(deps)(state(true))).resolves.toEqual(VOTES);

    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, "group@test", "poll-msg-1");
    expect(emitEvent).toHaveBeenCalledWith(deps.db, {
      bookingRuleId: "test-rule",
      jobRunId: "job-1",
      type: "poll_deleted",
      status: "success",
      targetDate: "2026-10-10",
      detail: { pollMsgId: "poll-msg-1" },
    });
    expect(resolveVotes).not.toHaveBeenCalled();
    expect(telegramTexts()).toEqual([CONFIRMED]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(unpinBestEffort).not.toHaveBeenCalled();
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
  });

  it("relance après clôture : « votants non identifiés » renvoyé sur Telegram à partir des votes repris, toujours aucun WhatsApp", async () => {
    const voter = { name: "Vince", phone: "+33663892186", option: "Non, mais je peux prêter mon nom" };
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollClosedAt: new Date() }));
    events({ question: QUESTION_WITH_CLOSURE }, { pollRequestId: "poll-1", ...VOTES, unresolvedVoters: [voter] }, 1, true);

    await createCollectVotesNode(deps)(state(true));

    expect(telegramTexts()[0]).toBe(CONFIRMED);
    expect(telegramTexts()[1]).toContain("[Samedi] ⚠️ 1 votant(s) non identifié(s)");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("relance après clôture, suppression retentée en échec (même « Message not found ») : Telegram, désépinglage tenté, étape réussie", async () => {
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollClosedAt: new Date("2026-10-05T07:00:00Z") }));
    events({ question: QUESTION_WITH_CLOSURE }, { pollRequestId: "poll-1", ...VOTES });
    vi.mocked(deleteMessage).mockRejectedValue(new Error("Message not found"));

    await expect(createCollectVotesNode(deps)(state(true))).resolves.toEqual(VOTES);

    expect(resolveVotes).not.toHaveBeenCalled();
    expect(telegramTexts()).toEqual([
      "[Samedi] Relance de la collecte : suppression du sondage non confirmée (Message not found) — vérifier dans le groupe et le supprimer à la main s'il est encore là.",
      CONFIRMED,
    ]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "poll-msg-1", "du sondage");
    expect(vi.mocked(emitEvent).mock.calls.filter((c) => c[1].type === "poll_deleted")).toEqual([]);
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
  });

  it("relance après clôture sans pollMsgId : pas de suppression retentée", async () => {
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollClosedAt: new Date(), pollMsgId: null }));
    events({ question: QUESTION_WITH_CLOSURE }, { pollRequestId: "poll-1", ...VOTES });

    await expect(createCollectVotesNode(deps)(state())).resolves.toEqual(VOTES);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("relance avec poll_closed_at sans événement : échec explicite", async () => {
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollClosedAt: new Date() }));
    events({ question: QUESTION_WITH_CLOSURE }, undefined);

    await expect(createCollectVotesNode(deps)(state())).rejects.toThrow("sondage fermé, votes introuvables");
    expect(resolveVotes).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
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

describe("createCollectVotesNode — lecture vide suspecte (huddle-bot redémarré : aucune réponse lue)", () => {
  const NOBODY = {
    confirmedPlayerIdsByTime: { "10H30": [] as string[] },
    volunteerSubstituteIds: [] as string[],
    unresolvedVoters: [] as UnresolvedVoter[],
    voterNames: {} as Record<string, string>,
  };
  const ALERT =
    "[Samedi] ⚠️ Aucune réponse lue au sondage (personne, même « Non ») — possible perte des votes côté huddle-bot (redémarrage ?). " +
    "Sondage conservé, aucun récap envoyé : vérifier les votes dans le groupe, puis « Recalculer le plan » si besoin.";

  it("0 répondant : sondage conservé (ni poll_closed_at ni suppression), désépinglage seul, pas de récap, alerte Telegram, pipeline continue", async () => {
    vi.mocked(resolveVotes).mockResolvedValue({ ...NOBODY, respondentCount: 0 });

    const result = await createCollectVotesNode(deps)(state(true));

    expect(result).toEqual(NOBODY);
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "poll-msg-1", "du sondage");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(telegramTexts()).toEqual(["[Samedi] Confirmés par heure — 10H30 : 0.", ALERT]);
  });

  it("des réponses mais aucun inscrit (que des « Non ») : suppression et récap « Personne cette semaine 😢 »", async () => {
    vi.mocked(resolveVotes).mockResolvedValue({ ...NOBODY, respondentCount: 3 });

    await createCollectVotesNode(deps)(state(true));

    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, "group@test", "poll-msg-1");
    expect(sendMessage).toHaveBeenCalledWith(
      deps.huddleBot.client,
      "group@test",
      "🔒 Inscriptions closes — samedi 10 octobre\nPersonne cette semaine 😢",
    );
    expect(telegramTexts().some((t) => t.includes("Aucune réponse lue"))).toBe(false);
  });
});

describe("createCollectVotesNode — garde-fou d'âge du sondage (WhatsApp : suppression pour tous ≈ 60 h)", () => {
  it("sondage envoyé il y a 47 h : supprimé", async () => {
    events({ question: QUESTION_WITH_CLOSURE }, undefined, 47);

    await createCollectVotesNode(deps)(state(true));

    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, "group@test", "poll-msg-1");
    expect(setJobRunPollClosedAt).toHaveBeenCalledWith(deps.db, "job-1", expect.any(Date));
  });

  it("sondage envoyé il y a 49 h : non supprimé, poll_closed_at non écrit, Telegram, désépinglage seul", async () => {
    events({ question: QUESTION_WITH_CLOSURE }, undefined, 49.5);

    const result = await createCollectVotesNode(deps)(state(true));

    expect(result).toEqual(VOTES);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
    expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "poll-msg-1", "du sondage");
    expect(telegramTexts()).toContain(
      "[Samedi] Sondage non supprimé : envoyé il y a 49 h (au-delà de 48 h, WhatsApp ne permet plus de le supprimer pour tous) — à supprimer à la main dans le groupe si besoin.",
    );
    expect(String(vi.mocked(sendMessage).mock.calls[0]![2]).startsWith("📋 Inscrits — ")).toBe(true);
  });

  it("date d'envoi du sondage introuvable : non supprimé, Telegram, désépinglage seul", async () => {
    events({ question: QUESTION_WITH_CLOSURE }, undefined, null);

    await createCollectVotesNode(deps)(state(true));

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
    expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "poll-msg-1", "du sondage");
    expect(telegramTexts().some((t) => t.startsWith("[Samedi] Sondage non supprimé : date d'envoi introuvable"))).toBe(true);
  });
});

describe("createCollectVotesNode — garde-fou d'âge à la relance après clôture", () => {
  beforeEach(() => {
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollClosedAt: new Date() }));
  });

  it("relance, sondage envoyé il y a 49 h : suppression non retentée, Telegram, désépinglage tenté", async () => {
    events({ question: QUESTION_WITH_CLOSURE }, { pollRequestId: "poll-1", ...VOTES }, 49.5);

    await expect(createCollectVotesNode(deps)(state(true))).resolves.toEqual(VOTES);

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(telegramTexts()).toEqual([
      "[Samedi] Relance de la collecte : sondage envoyé il y a 49 h (au-delà de 48 h), suppression non retentée — vérifier dans le groupe et le supprimer à la main s'il est encore là.",
      CONFIRMED,
    ]);
    expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "poll-msg-1", "du sondage");
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
  });

  it("relance, date d'envoi introuvable : suppression non retentée, Telegram, désépinglage tenté", async () => {
    events({ question: QUESTION_WITH_CLOSURE }, { pollRequestId: "poll-1", ...VOTES }, null);

    await createCollectVotesNode(deps)(state(true));

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(telegramTexts()).toEqual([
      "[Samedi] Relance de la collecte : date d'envoi du sondage introuvable, suppression non retentée — vérifier dans le groupe et le supprimer à la main s'il est encore là.",
      CONFIRMED,
    ]);
    expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "poll-msg-1", "du sondage");
  });

  it("relance, sondage envoyé il y a 47 h : suppression retentée", async () => {
    events({ question: QUESTION_WITH_CLOSURE }, { pollRequestId: "poll-1", ...VOTES }, 47);

    await createCollectVotesNode(deps)(state(true));

    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, "group@test", "poll-msg-1");
    expect(telegramTexts()).toEqual([CONFIRMED]);
  });
});

describe("createCollectVotesNode — événement poll_deleted (pas de faux Telegram à la relance)", () => {
  const pollDeletedCalls = () => vi.mocked(emitEvent).mock.calls.filter((c) => c[1].type === "poll_deleted");

  it("collecte, suppression réussie : événement poll_deleted/success écrit juste après la suppression", async () => {
    const calls: string[] = [];
    vi.mocked(deleteMessage).mockImplementation(async () => { calls.push("delete"); });
    vi.mocked(emitEvent).mockImplementation(async (_db, e) => { calls.push(`event:${e.type}`); });
    vi.mocked(sendMessage).mockImplementation(async () => { calls.push("recap"); return { msgId: "recap-1" }; });

    await createCollectVotesNode(deps)(state());

    expect(emitEvent).toHaveBeenCalledWith(deps.db, {
      bookingRuleId: "test-rule",
      jobRunId: "job-1",
      type: "poll_deleted",
      status: "success",
      targetDate: "2026-10-10",
      detail: { pollMsgId: "poll-msg-1" },
    });
    expect(calls).toEqual(["delete", "event:poll_deleted", "recap"]);
  });

  it("collecte, suppression en échec : aucun événement poll_deleted", async () => {
    vi.mocked(deleteMessage).mockRejectedValue(new Error("boom"));
    await createCollectVotesNode(deps)(state());
    expect(pollDeletedCalls()).toEqual([]);
  });

  it("collecte, écriture de poll_deleted en échec : Telegram debug, sondage bien considéré supprimé, étape réussie", async () => {
    vi.mocked(emitEvent).mockRejectedValue(new Error("events insert down"));

    await expect(createCollectVotesNode(deps)(state())).resolves.toEqual(VOTES);

    expect(telegramTexts()).toContain("[Samedi] Sondage supprimé mais événement poll_deleted non enregistré : events insert down");
    expect(String(vi.mocked(sendMessage).mock.calls[0]![2]).startsWith("🔒 Inscriptions closes — ")).toBe(true);
  });

  it("relance avec un événement poll_deleted : aucune suppression retentée, aucune alerte (seulement le Telegram de collecte)", async () => {
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollClosedAt: new Date() }));
    events({ question: QUESTION_WITH_CLOSURE }, { pollRequestId: "poll-1", ...VOTES }, 1, true);

    await expect(createCollectVotesNode(deps)(state(true))).resolves.toEqual(VOTES);

    expect(findLastSuccessfulEvent).toHaveBeenCalledWith(deps.db, "job-1", "poll_deleted");
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(unpinBestEffort).not.toHaveBeenCalled();
    expect(telegramTexts()).toEqual([CONFIRMED]);
  });

  it("relance avec un événement poll_deleted, même sondage de plus de 48 h : aucune alerte", async () => {
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollClosedAt: new Date() }));
    events({ question: QUESTION_WITH_CLOSURE }, { pollRequestId: "poll-1", ...VOTES }, 72, true);

    await createCollectVotesNode(deps)(state(true));

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(telegramTexts()).toEqual([CONFIRMED]);
  });

  it("relance sans événement poll_deleted : suppression retentée", async () => {
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollClosedAt: new Date() }));
    events({ question: QUESTION_WITH_CLOSURE }, { pollRequestId: "poll-1", ...VOTES }, 1, false);

    await createCollectVotesNode(deps)(state(true));

    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, "group@test", "poll-msg-1");
  });
});

describe("createCollectVotesNode — récap honnête si le sondage n'est pas supprimé", () => {
  const recapText = () => String(vi.mocked(sendMessage).mock.calls[0]![2]);

  it("sondage supprimé : « 🔒 Inscriptions closes »", async () => {
    await createCollectVotesNode(deps)(state());
    expect(recapText().startsWith("🔒 Inscriptions closes — ")).toBe(true);
  });

  it("ancien sondage sans marqueur : « 📋 Inscrits »", async () => {
    events({ question: "Squash samedi 10 octobre à 10h30 ?" });
    await createCollectVotesNode(deps)(state());
    expect(recapText().startsWith("📋 Inscrits — ")).toBe(true);
  });

  it("pollMsgId inconnu : « 📋 Inscrits »", async () => {
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollMsgId: null }));
    await createCollectVotesNode(deps)(state());
    expect(recapText().startsWith("📋 Inscrits — ")).toBe(true);
  });

  it("écriture de poll_closed_at en échec : « 📋 Inscrits »", async () => {
    vi.mocked(setJobRunPollClosedAt).mockRejectedValue(new Error("pg down"));
    await createCollectVotesNode(deps)(state());
    expect(recapText().startsWith("📋 Inscrits — ")).toBe(true);
  });

  it("suppression en échec : « 📋 Inscrits »", async () => {
    vi.mocked(deleteMessage).mockRejectedValue(new Error("boom"));
    await createCollectVotesNode(deps)(state());
    expect(recapText().startsWith("📋 Inscrits — ")).toBe(true);
  });

  it("mode test (récap sur un autre groupe) : garde « 🔒 Inscriptions closes »", async () => {
    vi.mocked(resolveAnnounceNotifyJid).mockResolvedValue("test@g.us");
    await createCollectVotesNode(deps)(state());
    expect(recapText().startsWith("🔒 Inscriptions closes — ")).toBe(true);
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

  it("épinglage en échec : récap non mémorisé (rien à désépingler)", async () => {
    vi.mocked(pinBestEffort).mockResolvedValue(false);

    await createCollectVotesNode(deps)(state(true));

    expect(pinBestEffort).toHaveBeenCalled();
    expect(setJobRunRecapInfo).not.toHaveBeenCalled();
  });

  it("mémorisation en échec après envoi et épinglage : message dédié, pas « non envoyé », le nœud réussit", async () => {
    vi.mocked(setJobRunRecapInfo).mockRejectedValue(new Error("db down"));

    await expect(createCollectVotesNode(deps)(state(true))).resolves.toBeDefined();

    expect(telegramTexts()).toContain(
      "[Samedi] Récap des inscrits envoyé et épinglé mais non mémorisé (désépinglage automatique impossible) : db down",
    );
    expect(telegramTexts().some((t) => t.includes("non envoyé"))).toBe(false);
  });

  it("épinglage désactivé : récap envoyé, ni épinglé ni mémorisé", async () => {
    await createCollectVotesNode(deps)(state(false));

    expect(sendMessage).toHaveBeenCalled();
    expect(pinBestEffort).not.toHaveBeenCalled();
    expect(setJobRunRecapInfo).not.toHaveBeenCalled();
  });

  it("Telegram : « Confirmés par heure » puis non-identifiés, avant le récap", async () => {
    const voter = { name: "Vince", phone: "+33663892186", option: "Non, mais je peux prêter mon nom" };
    vi.mocked(resolveVotes).mockResolvedValue({ ...READ, unresolvedVoters: [voter] });

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

describe("createCollectVotesNode — invariant : événement collect_votes écrit AVANT la clôture (vrai withEventLogging)", () => {
  /** Seule l'écriture d'événement est simulée (db.insert(...).values) ; elle enregistre l'ordre. */
  function depsWithEventWriter(calls: string[], failWrite = false): GraphDependencies {
    const db = {
      insert: () => ({
        values: async (row: { type: string; status: string }) => {
          calls.push(`event:${row.type}/${row.status}`);
          if (failWrite) throw new Error("events insert down");
        },
      }),
    };
    return { ...deps, db } as unknown as GraphDependencies;
  }

  beforeEach(() => {
    vi.mocked(withEventLogging).mockImplementation(actualEmitEvent.withEventLogging);
  });

  it("collect_votes/success écrit avant setJobRunPollClosedAt et avant deleteMessage", async () => {
    const calls: string[] = [];
    vi.mocked(setJobRunPollClosedAt).mockImplementation(async () => { calls.push("closed"); });
    vi.mocked(deleteMessage).mockImplementation(async () => { calls.push("delete"); });

    await createCollectVotesNode(depsWithEventWriter(calls))(state());

    expect(calls).toEqual(["event:collect_votes/success", "closed", "delete"]);
  });

  it("écriture de l'événement en échec : ni setJobRunPollClosedAt ni deleteMessage, l'étape échoue", async () => {
    const calls: string[] = [];

    await expect(createCollectVotesNode(depsWithEventWriter(calls, true))(state())).rejects.toThrow("events insert down");

    expect(calls[0]).toBe("event:collect_votes/success");
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});
