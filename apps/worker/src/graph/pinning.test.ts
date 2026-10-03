import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDependencies } from "./dependencies.js";

vi.mock("../mcp/huddleBot.js", () => ({
  pinMessage: vi.fn(async () => ({ expiresAt: 0 })),
  unpinMessage: vi.fn(async () => {}),
}));

vi.mock("../telegram/telegram.js", () => ({
  sendTelegramMessage: vi.fn(async () => {}),
}));

const { pinBestEffort, unpinBestEffort } = await import("./pinning.js");
const { pinMessage, unpinMessage } = await import("../mcp/huddleBot.js");
const { sendTelegramMessage } = await import("../telegram/telegram.js");

const deps = {
  huddleBot: { client: {} as never, close: async () => {} },
  telegram: { botToken: "t", chatId: "c" },
} as unknown as GraphDependencies;

describe("pinBestEffort / unpinBestEffort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("épingle pour 7 jours", async () => {
    await pinBestEffort(deps, "Mardi", "group@test", "msg-1", "du sondage");

    expect(pinMessage).toHaveBeenCalledWith(expect.anything(), "group@test", "msg-1", "7d");
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("ne relance pas l'erreur d'épinglage et la signale sur Telegram", async () => {
    vi.mocked(pinMessage).mockRejectedValueOnce(new Error("boom"));

    await expect(pinBestEffort(deps, "Mardi", "group@test", "msg-1", "du sondage")).resolves.toBeUndefined();

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
