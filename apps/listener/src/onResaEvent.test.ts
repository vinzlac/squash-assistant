import { describe, expect, it, vi } from "vitest";
import { onResaEvent } from "./onResaEvent.js";
import { WhatsAppEventType } from "./whatsappEvents.js";

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

describe("onResaEvent", () => {
  it("délègue au relay", async () => {
    const relay = vi.fn(async () => {});
    await onResaEvent({ relay }, event as never);
    expect(relay).toHaveBeenCalledWith(event);
  });

  it("broadcast après relay", async () => {
    const relay = vi.fn(async () => {});
    const broadcast = vi.fn();
    await onResaEvent({ relay, broadcast }, event as never);
    expect(relay).toHaveBeenCalledBefore(broadcast);
    expect(broadcast).toHaveBeenCalledWith(event);
  });

  it("ne fait pas échouer si broadcast lève", async () => {
    const relay = vi.fn(async () => {});
    const broadcast = vi.fn(() => {
      throw new Error("sse down");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(onResaEvent({ relay, broadcast }, event as never)).resolves.toBeUndefined();
    expect(relay).toHaveBeenCalledWith(event);
    expect(errSpy).toHaveBeenCalledWith("[listener] broadcast SSE échoué", expect.any(Error));
    errSpy.mockRestore();
  });
});
