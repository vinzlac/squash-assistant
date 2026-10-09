import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDependencies } from "./dependencies.js";

vi.mock("../mcp/huddleBot.js", () => ({
  pinMessage: vi.fn(async () => ({ expiresAt: 0 })),
  unpinMessage: vi.fn(async () => {}),
}));

vi.mock("../telegram/telegram.js", () => ({
  sendTelegramMessage: vi.fn(async () => {}),
}));

vi.mock("../jobRuns.js", () => ({ setJobRunRecapInfo: vi.fn(async () => {}) }));

const { pinBestEffort, unpinBestEffort, unpinRecapNow } = await import("./pinning.js");
const { pinMessage, unpinMessage } = await import("../mcp/huddleBot.js");
const { sendTelegramMessage } = await import("../telegram/telegram.js");
const { setJobRunRecapInfo } = await import("../jobRuns.js");

const deps = {
  huddleBot: { client: {} as never, close: async () => {} },
  telegram: { botToken: "t", chatId: "c" },
  db: {} as never,
} as unknown as GraphDependencies;

describe("pinBestEffort / unpinBestEffort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("épingle pour 7 jours", async () => {
    await expect(pinBestEffort(deps, "Mardi", "group@test", "msg-1", "du sondage")).resolves.toBe(true);
    vi.clearAllMocks();
    await pinBestEffort(deps, "Mardi", "group@test", "msg-1", "du sondage");

    expect(pinMessage).toHaveBeenCalledWith(expect.anything(), "group@test", "msg-1", "7d");
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("ne relance pas l'erreur d'épinglage et la signale sur Telegram", async () => {
    vi.mocked(pinMessage).mockRejectedValueOnce(new Error("boom"));

    await expect(pinBestEffort(deps, "Mardi", "group@test", "msg-1", "du sondage")).resolves.toBe(false);

    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("[Mardi] Épinglage du sondage échoué : "),
    );
  });

  it("désépingle et confirme le succès", async () => {
    await expect(unpinBestEffort(deps, "Mardi", "group@test", "msg-1", "de l'annonce")).resolves.toBe(true);

    expect(unpinMessage).toHaveBeenCalledWith(expect.anything(), "group@test", "msg-1");
  });

  it("ne relance pas l'erreur de désépinglage et la signale sur Telegram", async () => {
    vi.mocked(unpinMessage).mockRejectedValueOnce(new Error("boom"));

    await expect(unpinBestEffort(deps, "Mardi", "group@test", "msg-1", "de l'annonce")).resolves.toBe(false);

    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("[Mardi] Désépinglage de l'annonce échoué : "),
    );
  });
});

describe("unpinRecapNow (spec 2026-10-09 §2.3)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sans récap épinglé : rien", async () => {
    await unpinRecapNow(deps, "Samedi", { id: "job-1", recapMsgId: null, recapJid: null });
    expect(unpinMessage).not.toHaveBeenCalled();
  });

  it("désépingle puis oublie le récap", async () => {
    await unpinRecapNow(deps, "Samedi", { id: "job-1", recapMsgId: "recap-1", recapJid: "g@test" });
    expect(unpinMessage).toHaveBeenCalledWith(expect.anything(), "g@test", "recap-1");
    expect(setJobRunRecapInfo).toHaveBeenCalledWith(deps.db, "job-1", null);
  });

  it("désépinglage en échec : récap conservé, aucune exception", async () => {
    vi.mocked(unpinMessage).mockRejectedValueOnce(new Error("boom"));
    await expect(unpinRecapNow(deps, "Samedi", { id: "job-1", recapMsgId: "recap-1", recapJid: "g@test" })).resolves.toBeUndefined();
    expect(setJobRunRecapInfo).not.toHaveBeenCalled();
  });
});
