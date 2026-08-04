import { describe, expect, it } from "vitest";
import {
  isResaEventType,
  parseWhatsAppEvent,
  sanitizeWhatsAppJidForSubject,
  whatsAppEventSubject,
  WhatsAppEventType,
} from "./whatsappEvents.js";

describe("sanitizeWhatsAppJidForSubject", () => {
  it("remplace @ et .", () => {
    expect(sanitizeWhatsAppJidForSubject("120363@g.us")).toBe("120363_g_us");
  });
});

describe("whatsAppEventSubject", () => {
  it("préfixe homelab.whatsapp.", () => {
    expect(whatsAppEventSubject("120363@g.us")).toBe("homelab.whatsapp.120363_g_us");
  });
});

describe("isResaEventType", () => {
  it("accepte poll_* résa", () => {
    expect(isResaEventType(WhatsAppEventType.PollVoteCreation)).toBe(true);
    expect(isResaEventType(WhatsAppEventType.MessageCreation)).toBe(false);
  });
});

describe("parseWhatsAppEvent", () => {
  it("parse un poll_vote_creation", () => {
    const event = parseWhatsAppEvent({
      eventId: "e1",
      eventType: "poll_vote_creation",
      occurredAt: "2026-08-04T08:00:00.000Z",
      chat: { jid: "120363@g.us", name: "Squash", isGroup: true },
      actor: { phone: "33600", displayName: "Alice", jid: "33600@s.whatsapp.net" },
      data: {
        pollWhatsappMessageId: "m1",
        pollName: "Qui joue ?",
        selectedOptions: ["18H45"],
        previousOptions: [],
      },
    });
    expect(event.eventType).toBe("poll_vote_creation");
  });

  it("rejette un payload sans eventType", () => {
    expect(() => parseWhatsAppEvent({ eventId: "x" })).toThrow();
  });
});
