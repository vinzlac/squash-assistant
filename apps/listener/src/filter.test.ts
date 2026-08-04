import { describe, expect, it } from "vitest";
import { shouldRelay } from "./filter.js";
import { WhatsAppEventType, type WhatsAppEvent } from "./whatsappEvents.js";

const vincent = "120363424956785709@g.us";
const squash = "120363041739962569@g.us";

function base(over: Partial<WhatsAppEvent> & { eventType: WhatsAppEventType; chatJid?: string }): WhatsAppEvent {
  return {
    eventId: "e1",
    eventType: over.eventType,
    occurredAt: "2026-08-04T08:00:00.000Z",
    chat: { jid: over.chatJid ?? squash, name: "G", isGroup: true },
    actor: { phone: null, displayName: "A", jid: "a@s.whatsapp.net" },
    data: over.data ?? {
      pollWhatsappMessageId: "m",
      pollName: "Qui ?",
      selectedOptions: ["18H45"],
      previousOptions: [],
    },
  } as WhatsAppEvent;
}

describe("shouldRelay", () => {
  const allow = new Set([squash]);

  it("relaye poll_vote sur groupe allowlist", () => {
    expect(shouldRelay(base({ eventType: WhatsAppEventType.PollVoteCreation }), allow, vincent)).toBe(true);
  });

  it("ignore message_creation même allowlist", () => {
    expect(
      shouldRelay(
        base({
          eventType: WhatsAppEventType.MessageCreation,
          data: { whatsappMessageId: "m", content: "hi" },
        } as never),
        allow,
        vincent,
      ),
    ).toBe(false);
  });

  it("ignore Vincent All même si dans allowlist par erreur", () => {
    expect(
      shouldRelay(
        base({ eventType: WhatsAppEventType.PollVoteCreation, chatJid: vincent }),
        new Set([vincent, squash]),
        vincent,
      ),
    ).toBe(false);
  });

  it("ignore JID hors allowlist", () => {
    expect(
      shouldRelay(base({ eventType: WhatsAppEventType.PollVoteCreation, chatJid: "other@g.us" }), allow, vincent),
    ).toBe(false);
  });
});
