import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRun } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../graph/dependencies.js";

vi.mock("../mcp/huddleBot.js", () => ({
  sendMessage: vi.fn(),
  deleteMessage: vi.fn(),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
}));
vi.mock("./rosterStore.js", () => ({
  claimRosterPublish: vi.fn(),
  releaseRosterPublish: vi.fn(),
  setRosterMessage: vi.fn(),
  setRosterFingerprint: vi.fn(),
  setRosterPinnedAt: vi.fn(),
  setRosterOrphan: vi.fn(),
}));
vi.mock("../telegram/telegram.js", () => ({ sendTelegramMessage: vi.fn() }));

const { publishRoster, withdrawRoster, retryOrphanUnpin, __resetRosterTelegramLogForTests } = await import(
  "./publishRoster.js"
);
const { sendMessage, deleteMessage, pinMessage, unpinMessage } = await import("../mcp/huddleBot.js");
const {
  claimRosterPublish,
  releaseRosterPublish,
  setRosterMessage,
  setRosterFingerprint,
  setRosterPinnedAt,
  setRosterOrphan,
} = await import("./rosterStore.js");
const { sendTelegramMessage } = await import("../telegram/telegram.js");
const { rosterFingerprint } = await import("./rosterMessage.js");

const deps = {
  huddleBot: { client: {} as never, close: async () => {} },
  telegram: { botToken: "t", chatId: "c" },
  db: {} as never,
} as unknown as Pick<GraphDependencies, "db" | "huddleBot" | "telegram">;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-10-20T10:00:00.000Z");
const hoursBefore = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS);
const GROUP = "group@g.us";
const TEXT = "📋 Inscrits — samedi\nHugo";

function job(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: "job-1",
    rosterMsgId: null,
    rosterJid: null,
    rosterSentAt: null,
    rosterFingerprint: null,
    rosterPinnedAt: null,
    rosterOrphan: null,
    rosterFinal: null,
    rosterStoppedAt: null,
    ...overrides,
  } as JobRun;
}

/** Ancien roster publié il y a `ageHours` h, épinglé ou non. */
function withOldRoster(ageHours: number, pinned: boolean, overrides: Partial<JobRun> = {}): JobRun {
  const sentAt = hoursBefore(ageHours);
  return job({
    rosterMsgId: "old-msg",
    rosterJid: GROUP,
    rosterSentAt: sentAt,
    rosterFingerprint: "old-fp",
    rosterPinnedAt: pinned ? sentAt : null,
    ...overrides,
  });
}

function ctx(current: JobRun, overrides: { pinEnabled?: boolean } = {}) {
  return { deps, job: current, ruleLabel: "Samedi", pinEnabled: overrides.pinEnabled ?? true, notifyJid: GROUP, now: NOW };
}

function claimReturns(fresh: JobRun, reclaimedStale = false): void {
  vi.mocked(claimRosterPublish).mockResolvedValue({ job: fresh, reclaimedStale });
}

const telegramTexts = () => vi.mocked(sendTelegramMessage).mock.calls.map(([, text]) => text);

beforeEach(() => {
  vi.resetAllMocks();
  __resetRosterTelegramLogForTests();
  vi.mocked(sendMessage).mockResolvedValue({ msgId: "new-msg" });
  vi.mocked(sendTelegramMessage).mockResolvedValue(undefined);
  vi.mocked(pinMessage).mockResolvedValue({ expiresAt: 0 });
});

describe("publishRoster", () => {
  it("empreinte inchangée → aucun envoi", async () => {
    const current = job({ rosterFingerprint: rosterFingerprint(TEXT) });

    const outcome = await publishRoster(ctx(current), TEXT, "provisional");

    expect(outcome).toBe("unchanged");
    expect(claimRosterPublish).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("CA-9 : ancien roster < 48 h → deleteMessage, nouveau épinglé", async () => {
    const old = withOldRoster(10, true);
    claimReturns(old);

    const outcome = await publishRoster(ctx(old), TEXT, "provisional");

    expect(outcome).toBe("published");
    expect(setRosterMessage).toHaveBeenCalledWith(deps.db, "job-1", {
      msgId: "new-msg",
      jid: GROUP,
      sentAt: NOW,
      fingerprint: rosterFingerprint(TEXT),
    });
    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, GROUP, "old-msg");
    expect(unpinMessage).not.toHaveBeenCalled();
    expect(pinMessage).toHaveBeenCalledWith(deps.huddleBot.client, GROUP, "new-msg", "7d");
    expect(setRosterPinnedAt).toHaveBeenCalledWith(deps.db, "job-1", NOW);
    expect(releaseRosterPublish).toHaveBeenCalledWith(deps.db, "job-1", NOW);
  });

  it("CA-9 : ancien roster ≥ 48 h, épinglé → unpin seul, pas de delete", async () => {
    const old = withOldRoster(48, true);
    claimReturns(old);

    await publishRoster(ctx(old), TEXT, "provisional");

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(unpinMessage).toHaveBeenCalledWith(deps.huddleBot.client, GROUP, "old-msg");
    expect(pinMessage).toHaveBeenCalledWith(deps.huddleBot.client, GROUP, "new-msg", "7d");
  });

  it("CA-9 : ancien ≥ 48 h, pin désactivé → ni delete ni unpin", async () => {
    const old = withOldRoster(72, false);
    claimReturns(old);

    const outcome = await publishRoster(ctx(old, { pinEnabled: false }), TEXT, "provisional");

    expect(outcome).toBe("published");
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(unpinMessage).not.toHaveBeenCalled();
    expect(pinMessage).not.toHaveBeenCalled();
    expect(setRosterPinnedAt).not.toHaveBeenCalled();
  });

  it("ordre : sendMessage avant tout retrait, épinglage du nouveau après le retrait", async () => {
    const old = withOldRoster(10, true);
    claimReturns(old);
    vi.mocked(deleteMessage).mockRejectedValue(new Error("delete KO"));

    await publishRoster(ctx(old), TEXT, "provisional");

    const send = vi.mocked(sendMessage).mock.invocationCallOrder[0]!;
    const del = vi.mocked(deleteMessage).mock.invocationCallOrder[0]!;
    const unpin = vi.mocked(unpinMessage).mock.invocationCallOrder[0]!;
    const pin = vi.mocked(pinMessage).mock.invocationCallOrder[0]!;
    expect(send).toBeLessThan(del);
    expect(del).toBeLessThan(unpin);
    expect(unpin).toBeLessThan(pin);
  });

  it("R2-3/C2-1 : delete et unpin échouent → orphelin mémorisé (expiresAt = rosterPinnedAt + 7 j), nouveau non épinglé, Telegram", async () => {
    const old = withOldRoster(10, true);
    claimReturns(old);
    vi.mocked(deleteMessage).mockRejectedValue(new Error("delete KO"));
    vi.mocked(unpinMessage).mockRejectedValue(new Error("unpin KO"));

    const outcome = await publishRoster(ctx(old), TEXT, "provisional");

    expect(outcome).toBe("published");
    expect(setRosterOrphan).toHaveBeenCalledWith(deps.db, "job-1", {
      msgId: "old-msg",
      jid: GROUP,
      expiresAt: new Date(hoursBefore(10).getTime() + 7 * DAY_MS).toISOString(),
    });
    expect(pinMessage).not.toHaveBeenCalled();
    expect(telegramTexts().some((t) => t.includes("unpin KO"))).toBe(true);
    expect(telegramTexts().some((t) => t.includes("delete KO"))).toBe(true);
  });

  it("P1-1 : claim obtenu après une publication concurrente → empreinte et ancien message relus sur la ligne fraîche, aucun envoi", async () => {
    const stale = withOldRoster(10, true);
    claimReturns(withOldRoster(1, true, { rosterMsgId: "concurrent-msg", rosterFingerprint: rosterFingerprint(TEXT) }));

    const outcome = await publishRoster(ctx(stale), TEXT, "provisional");

    expect(outcome).toBe("unchanged");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(releaseRosterPublish).toHaveBeenCalledWith(deps.db, "job-1", NOW);
  });

  it("P1-1 : provisoire refusé si la ligne fraîche a déjà un rosterFinal", async () => {
    const current = withOldRoster(10, true);
    claimReturns({ ...current, rosterFinal: {} as JobRun["rosterFinal"] });

    const outcome = await publishRoster(ctx(current), TEXT, "provisional");

    expect(outcome).toBe("unchanged");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("P1-1 : le définitif remplace un roster même si rosterFinal existe", async () => {
    const current = withOldRoster(10, true, { rosterFinal: {} as JobRun["rosterFinal"] });
    claimReturns(current);

    expect(await publishRoster(ctx(current), TEXT, "final")).toBe("published");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("P2-14 : ancien roster non épinglé dont la suppression échoue → nouveau épinglé", async () => {
    const old = withOldRoster(10, false);
    claimReturns(old);
    vi.mocked(deleteMessage).mockRejectedValue(new Error("delete KO"));

    await publishRoster(ctx(old), TEXT, "provisional");

    expect(unpinMessage).not.toHaveBeenCalled();
    expect(setRosterOrphan).not.toHaveBeenCalled();
    expect(pinMessage).toHaveBeenCalledWith(deps.huddleBot.client, GROUP, "new-msg", "7d");
  });

  it("envoi sans msgId → empreinte mémorisée, ancien non retiré, Telegram", async () => {
    const old = withOldRoster(10, true);
    claimReturns(old);
    vi.mocked(sendMessage).mockResolvedValue({});

    const outcome = await publishRoster(ctx(old), TEXT, "provisional");

    expect(outcome).toBe("published");
    expect(setRosterFingerprint).toHaveBeenCalledWith(deps.db, "job-1", rosterFingerprint(TEXT));
    expect(setRosterMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(unpinMessage).not.toHaveBeenCalled();
    expect(pinMessage).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("claim périmé repris → Telegram « possible doublon »", async () => {
    claimReturns(job(), true);

    await publishRoster(ctx(job()), TEXT, "provisional");

    expect(telegramTexts().some((t) => t.includes("possible doublon"))).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("C2-1 : orphelin présent → aucun épinglage même si le retrait réussit", async () => {
    const old = withOldRoster(10, false, {
      rosterOrphan: { msgId: "orphan-msg", jid: GROUP, expiresAt: new Date(NOW.getTime() + DAY_MS).toISOString() },
    });
    claimReturns(old);

    await publishRoster(ctx(old), TEXT, "provisional");

    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, GROUP, "old-msg");
    expect(pinMessage).not.toHaveBeenCalled();
    expect(setRosterPinnedAt).not.toHaveBeenCalled();
  });

  it("claim en cours : aucun envoi concurrent", async () => {
    vi.mocked(claimRosterPublish).mockResolvedValue(null);

    const outcome = await publishRoster(ctx(job()), TEXT, "provisional");

    expect(outcome).toBe("busy");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(releaseRosterPublish).not.toHaveBeenCalled();
  });

  it('échec d\'envoi → "failed", empreinte non mise à jour, release appelé', async () => {
    const old = withOldRoster(10, true);
    claimReturns(old);
    vi.mocked(sendMessage).mockRejectedValue(new Error("WhatsApp KO"));

    const outcome = await publishRoster(ctx(old), TEXT, "provisional");

    expect(outcome).toBe("failed");
    expect(setRosterFingerprint).not.toHaveBeenCalled();
    expect(setRosterMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(releaseRosterPublish).toHaveBeenCalledWith(deps.db, "job-1", NOW);
    expect(telegramTexts().some((t) => t.includes("WhatsApp KO"))).toBe(true);
  });

  it("échecs d'envoi répétés → un seul Telegram par job", async () => {
    claimReturns(job());
    vi.mocked(sendMessage).mockRejectedValue(new Error("WhatsApp KO"));

    await publishRoster(ctx(job()), TEXT, "provisional");
    await publishRoster(ctx(job()), `${TEXT}\nVincent`, "provisional");

    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("release appelé même si une écriture en base lève", async () => {
    claimReturns(job());
    vi.mocked(setRosterMessage).mockRejectedValue(new Error("db KO"));

    await expect(publishRoster(ctx(job()), TEXT, "provisional")).rejects.toThrow("db KO");
    expect(releaseRosterPublish).toHaveBeenCalledWith(deps.db, "job-1", NOW);
  });

  it("épinglage du nouveau échoué → Telegram, toujours publié", async () => {
    claimReturns(job());
    vi.mocked(pinMessage).mockRejectedValue(new Error("pin KO"));

    expect(await publishRoster(ctx(job()), TEXT, "provisional")).toBe("published");
    expect(setRosterPinnedAt).not.toHaveBeenCalled();
    expect(telegramTexts().some((t) => t.includes("pin KO"))).toBe(true);
  });
});

describe("withdrawRoster", () => {
  it("withdrawRoster < 48 h → delete puis setRosterMessage(null)", async () => {
    const current = withOldRoster(10, true);
    claimReturns(current);

    expect(await withdrawRoster(ctx(current))).toBe(true);

    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, GROUP, "old-msg");
    expect(setRosterMessage).toHaveBeenCalledWith(deps.db, "job-1", null);
    expect(vi.mocked(deleteMessage).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(setRosterMessage).mock.invocationCallOrder[0]!,
    );
    expect(releaseRosterPublish).toHaveBeenCalledWith(deps.db, "job-1", NOW);
  });

  it("withdrawRoster unpinOnly → unpin sans delete, msgId et empreinte conservés", async () => {
    const current = withOldRoster(10, true);
    claimReturns(current);

    expect(await withdrawRoster(ctx(current), { unpinOnly: true })).toBe(true);

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(unpinMessage).toHaveBeenCalledWith(deps.huddleBot.client, GROUP, "old-msg");
    expect(setRosterPinnedAt).toHaveBeenCalledWith(deps.db, "job-1", null);
    expect(setRosterMessage).not.toHaveBeenCalled();
    expect(setRosterFingerprint).not.toHaveBeenCalled();
  });

  it("withdrawRoster unpinOnly, désépinglage échoué → orphelin depuis rosterPinnedAt frais, puis rosterPinnedAt oublié", async () => {
    const pinnedAt = hoursBefore(30);
    const current = withOldRoster(40, true, { rosterPinnedAt: pinnedAt });
    claimReturns(current);
    vi.mocked(unpinMessage).mockRejectedValue(new Error("unpin KO"));

    expect(await withdrawRoster(ctx(withOldRoster(40, false)), { unpinOnly: true })).toBe(true);

    expect(setRosterOrphan).toHaveBeenCalledWith(deps.db, "job-1", {
      msgId: "old-msg",
      jid: GROUP,
      expiresAt: new Date(pinnedAt.getTime() + 7 * DAY_MS).toISOString(),
    });
    expect(setRosterPinnedAt).toHaveBeenCalledWith(deps.db, "job-1", null);
    expect(vi.mocked(setRosterOrphan).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(setRosterPinnedAt).mock.invocationCallOrder[0]!,
    );
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(setRosterMessage).not.toHaveBeenCalled();
  });

  it("withdrawRoster claim occupé → rien, false", async () => {
    vi.mocked(claimRosterPublish).mockResolvedValue(null);

    expect(await withdrawRoster(ctx(withOldRoster(10, true)))).toBe(false);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(setRosterMessage).not.toHaveBeenCalled();
  });
});

describe("retryOrphanUnpin", () => {
  const orphan = { msgId: "orphan-msg", jid: GROUP, expiresAt: new Date(NOW.getTime() + DAY_MS).toISOString() };

  it("C3-2 : retryOrphanUnpin réussit → orphelin oublié et roster courant épinglé", async () => {
    const current = job({ rosterMsgId: "current-msg", rosterJid: "other@g.us", rosterOrphan: orphan });
    claimReturns({ ...current, rosterOrphan: null });

    await retryOrphanUnpin(ctx(current));

    expect(unpinMessage).toHaveBeenCalledWith(deps.huddleBot.client, GROUP, "orphan-msg");
    expect(setRosterOrphan).toHaveBeenCalledWith(deps.db, "job-1", null);
    expect(pinMessage).toHaveBeenCalledWith(deps.huddleBot.client, "other@g.us", "current-msg", "7d");
    expect(setRosterPinnedAt).toHaveBeenCalledWith(deps.db, "job-1", NOW);
    expect(releaseRosterPublish).toHaveBeenCalledWith(deps.db, "job-1", NOW);
  });

  it("retryOrphanUnpin après expiration → oublié sans appel huddle-bot", async () => {
    const expired = { ...orphan, expiresAt: NOW.toISOString() };

    await retryOrphanUnpin(ctx(job({ rosterMsgId: "current-msg", rosterJid: GROUP, rosterOrphan: expired })));

    expect(setRosterOrphan).toHaveBeenCalledWith(deps.db, "job-1", null);
    expect(unpinMessage).not.toHaveBeenCalled();
    expect(pinMessage).not.toHaveBeenCalled();
  });

  it("retryOrphanUnpin : orphelin = roster courant → désépinglé, jamais réépinglé", async () => {
    const current = job({ rosterMsgId: "orphan-msg", rosterJid: GROUP, rosterOrphan: orphan });
    claimReturns({ ...current, rosterOrphan: null });

    await retryOrphanUnpin(ctx(current));

    expect(unpinMessage).toHaveBeenCalledTimes(1);
    expect(setRosterOrphan).toHaveBeenCalledWith(deps.db, "job-1", null);
    expect(pinMessage).not.toHaveBeenCalled();
  });

  it("retryOrphanUnpin : désépinglage échoué → orphelin conservé", async () => {
    vi.mocked(unpinMessage).mockRejectedValue(new Error("unpin KO"));

    await retryOrphanUnpin(ctx(job({ rosterOrphan: orphan })));

    expect(setRosterOrphan).not.toHaveBeenCalled();
    expect(claimRosterPublish).not.toHaveBeenCalled();
  });

  it("retryOrphanUnpin : roster arrêté ou pin désactivé → pas d'épinglage", async () => {
    const current = job({ rosterMsgId: "current-msg", rosterJid: GROUP, rosterOrphan: orphan });
    claimReturns({ ...current, rosterOrphan: null, rosterStoppedAt: NOW });
    await retryOrphanUnpin(ctx(current));
    await retryOrphanUnpin(ctx(current, { pinEnabled: false }));

    expect(pinMessage).not.toHaveBeenCalled();
  });
});
