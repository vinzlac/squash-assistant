import { describe, expect, it } from "vitest";
import { formatRelayMessage } from "./format.js";
import { WhatsAppEventType } from "./whatsappEvents.js";

describe("formatRelayMessage", () => {
  it("formate un vote", () => {
    const text = formatRelayMessage({
      eventId: "e1",
      eventType: WhatsAppEventType.PollVoteUpdate,
      occurredAt: "2026-08-04T08:00:00.000Z",
      chat: { jid: "120363@g.us", name: "Squash Académie", isGroup: true },
      actor: { phone: "33600", displayName: "Alice", jid: "33600@s.whatsapp.net" },
      data: {
        pollWhatsappMessageId: "m1",
        pollName: "Qui joue mardi ?",
        selectedOptions: ["19H30"],
        previousOptions: ["18H45"],
      },
    });
    expect(text).toContain("[squash] Squash Académie");
    expect(text).toContain("poll_vote_update — Alice");
    expect(text).toContain("sondage: Qui joue mardi ?");
    expect(text).toContain("options: 19H30");
  });

  it("formate une création de sondage", () => {
    const text = formatRelayMessage({
      eventId: "e2",
      eventType: WhatsAppEventType.PollCreation,
      occurredAt: "2026-08-04T08:00:00.000Z",
      chat: { jid: "120363@g.us", name: null, isGroup: true },
      actor: { phone: null, displayName: null, jid: "bot@s.whatsapp.net" },
      data: {
        whatsappMessageId: "m2",
        name: "Qui joue ?",
        options: ["18H45", "19H30"],
        allowMultiple: false,
      },
    });
    expect(text).toContain("[squash] 120363@g.us");
    expect(text).toContain("poll_creation");
    expect(text).toContain("options: 18H45, 19H30");
  });

  it("tolère des données de sondage incomplètes", () => {
    const text = formatRelayMessage({
      eventId: "e3",
      eventType: WhatsAppEventType.PollVoteUpdate,
      occurredAt: "2026-08-04T08:00:00.000Z",
      chat: { jid: "120363@g.us", name: "G", isGroup: true },
      actor: { phone: null, displayName: "Alice", jid: "a@s.whatsapp.net" },
      data: {} as never,
    });
    expect(text).toContain("sondage: (inconnu)");
    expect(text).toContain("options: (aucune)");
  });
});
