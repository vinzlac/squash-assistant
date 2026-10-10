import { describe, expect, it, vi } from "vitest";
import { relayToVincentAll } from "./relay.js";
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

describe("relayToVincentAll", () => {
  it("appelle sendMessage vers Vincent All", async () => {
    const sendMessage = vi.fn(
      async (_client: unknown, _jid: string, _text: string): Promise<void> => {},
    );
    await relayToVincentAll(
      {
        vincentAllGroupJid: "vincent@g.us",
        sendMessage,
        client: {} as never,
        resolveActorName: async () => "Hugo",
      },
      event as never,
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][1]).toBe("vincent@g.us");
    expect(sendMessage.mock.calls[0][2]).toBe("🗳️ Hugo a répondu 18H45 pour « Qui ? »");
  });
});
