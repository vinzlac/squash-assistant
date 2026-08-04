import { describe, expect, it, vi } from "vitest";
import { onResaEvent } from "./onResaEvent.js";
import { WhatsAppEventType } from "./whatsappEvents.js";

const settingsAllOn = {
  id: "default",
  pollCreation: true,
  pollVoteCreation: true,
  pollVoteUpdate: true,
  pollVoteDeletion: true,
  updatedAt: new Date(),
};

const event = {
  eventId: "e1",
  eventType: WhatsAppEventType.PollVoteCreation,
  occurredAt: "2026-08-04T08:00:00.000Z",
  chat: { jid: "g@g.us", name: "G", isGroup: true },
  actor: { phone: null, displayName: "Bob", jid: "b@s.whatsapp.net" },
  data: {
    pollWhatsappMessageId: "m",
    pollName: "Qui ?",
    selectedOptions: ["18H45"],
    previousOptions: [],
  },
} as const;

function deps(overrides: Partial<Parameters<typeof onResaEvent>[0]> = {}) {
  return {
    persist: vi.fn(async () => {}),
    relay: vi.fn(async () => {}),
    settings: settingsAllOn,
    ...overrides,
  };
}

describe("onResaEvent", () => {
  it("persist → broadcast → relay quand type activé", async () => {
    const persist = vi.fn(async () => {});
    const relay = vi.fn(async () => {});
    const broadcast = vi.fn();
    await onResaEvent({ persist, relay, broadcast, settings: settingsAllOn }, event as never);
    expect(persist).toHaveBeenCalledWith(event);
    expect(persist).toHaveBeenCalledBefore(relay);
    expect(broadcast).toHaveBeenCalledBefore(relay);
    expect(relay).toHaveBeenCalledWith(event);
  });

  it("skip relay si type désactivé", async () => {
    const relay = vi.fn(async () => {});
    await onResaEvent(
      {
        ...deps(),
        relay,
        settings: { ...settingsAllOn, pollVoteCreation: false },
      },
      event as never,
    );
    expect(relay).not.toHaveBeenCalled();
  });

  it("propage l'échec persist", async () => {
    const persist = vi.fn(async () => {
      throw new Error("pg down");
    });
    await expect(onResaEvent({ ...deps(), persist }, event as never)).rejects.toThrow("pg down");
  });

  it("ne fait pas échouer si broadcast lève", async () => {
    const relay = vi.fn(async () => {});
    const broadcast = vi.fn(() => {
      throw new Error("sse down");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      onResaEvent({ ...deps(), relay, broadcast }, event as never),
    ).resolves.toBeUndefined();
    expect(relay).toHaveBeenCalledWith(event);
    expect(errSpy).toHaveBeenCalledWith("[listener] broadcast SSE échoué", expect.any(Error));
    errSpy.mockRestore();
  });
});
