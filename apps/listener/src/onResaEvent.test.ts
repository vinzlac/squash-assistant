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
});
