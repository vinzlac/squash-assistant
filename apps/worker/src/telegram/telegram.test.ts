import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTelegramApiUrl, sendTelegramMessage, waitForGoConfirmation } from "./telegram.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("parseTelegramApiUrl", () => {
  it("api.telegram.org par défaut (absent ou vide), passerelle sinon, barre finale retirée", () => {
    expect(parseTelegramApiUrl(undefined)).toBe("https://api.telegram.org");
    expect(parseTelegramApiUrl("  ")).toBe("https://api.telegram.org");
    expect(parseTelegramApiUrl(" http://telegram-gateway.telegram-gateway.svc.cluster.local:8080/ ")).toBe(
      "http://telegram-gateway.telegram-gateway.svc.cluster.local:8080",
    );
  });

  it.each(["ftp://x", "pas une url", "http://", "http://gw?x=1", "http://gw#f", "http://u:p@gw"])(
    "TELEGRAM_API_URL invalide (%j) : erreur de config claire",
    (raw) => {
      expect(() => parseTelegramApiUrl(raw)).toThrow(/TELEGRAM_API_URL/);
    },
  );
});

describe("client Telegram et apiUrl (passerelle telegram-gateway)", () => {
  it("sendMessage passe par apiUrl quand il est fourni", async () => {
    const fetchMock = stubFetch({ ok: true, result: { message_id: 1 } });

    await sendTelegramMessage({ botToken: "T", chatId: "42", apiUrl: "http://gw:8080" }, "plan");

    expect(fetchMock.mock.calls[0]![0]).toBe("http://gw:8080/botT/sendMessage");
  });

  it("sendMessage reste sur api.telegram.org sans apiUrl", async () => {
    const fetchMock = stubFetch({ ok: true, result: { message_id: 1 } });

    await sendTelegramMessage({ botToken: "T", chatId: "42" }, "plan");

    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.telegram.org/botT/sendMessage");
  });

  it("l'attente du « go » interroge getUpdates sur apiUrl", async () => {
    const fetchMock = stubFetch({
      ok: true,
      result: [{ update_id: 7, message: { text: "go", chat: { id: 42 } } }],
    });

    const confirmed = await waitForGoConfirmation(
      { botToken: "T", chatId: "42", apiUrl: "http://gw:8080" },
      { timeoutMs: 1000 },
    );

    expect(confirmed).toBe(true);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(`${url.origin}${url.pathname}`).toBe("http://gw:8080/botT/getUpdates");
    // La passerelle calcule son délai d'attente depuis ce timeout (long-poll).
    expect(url.searchParams.get("timeout")).toBe("30");
  });
});

describe("attente du « go » résistante aux coupures (redémarrage de la passerelle)", () => {
  it("reprend après un échec réseau puis reçoit le « go » ; aucun update n'est sauté", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => "Bad Gateway" })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: [{ update_id: 100, message: { text: "go", chat: { id: 42 } } }] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const confirmed = await waitForGoConfirmation(
      { botToken: "T", chatId: "42", apiUrl: "http://gw:8080" },
      { timeoutMs: 5_000, retryDelayMs: 0 },
    );

    expect(confirmed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const offsets = fetchMock.mock.calls.map((call) => new URL(String(call[0])).searchParams.get("offset"));
    expect(new Set(offsets).size).toBe(1);
  });

  it("rend false à l'échéance si Telegram reste injoignable, sans lever d'erreur", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      waitForGoConfirmation({ botToken: "T", chatId: "42" }, { timeoutMs: 30, retryDelayMs: 5 }),
    ).resolves.toBe(false);
  });
});
