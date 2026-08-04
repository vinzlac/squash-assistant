import { describe, expect, it, vi } from "vitest";
import { createSseHub, toSsePayload } from "./sseHub.js";
import { WhatsAppEventType } from "./whatsappEvents.js";

describe("toSsePayload", () => {
  it("mappe PollVoteCreation", () => {
    const payload = toSsePayload({
      eventId: "e1",
      eventType: WhatsAppEventType.PollVoteCreation,
      occurredAt: "2026-08-04T08:00:00.000Z",
      chat: { jid: "120363@g.us", name: "G", isGroup: true },
      actor: { phone: "33600", displayName: "Alice", jid: "33600@s.whatsapp.net" },
      data: {
        pollWhatsappMessageId: "m1",
        pollName: "Qui joue mardi ?",
        selectedOptions: ["19H30"],
        previousOptions: [],
      },
    });
    expect(payload).toEqual({
      eventType: WhatsAppEventType.PollVoteCreation,
      chatJid: "120363@g.us",
      actor: { displayName: "Alice", phone: "33600", jid: "33600@s.whatsapp.net" },
      pollName: "Qui joue mardi ?",
      selectedOptions: ["19H30"],
      occurredAt: "2026-08-04T08:00:00.000Z",
    });
  });

  it("mappe PollCreation", () => {
    const payload = toSsePayload({
      eventId: "e2",
      eventType: WhatsAppEventType.PollCreation,
      occurredAt: "2026-08-04T09:00:00.000Z",
      chat: { jid: "120363@g.us", name: null, isGroup: true },
      actor: { phone: null, displayName: null, jid: "bot@s.whatsapp.net" },
      data: {
        whatsappMessageId: "m2",
        name: "Qui joue ?",
        options: ["18H45", "19H30"],
        allowMultiple: false,
      },
    });
    expect(payload).toEqual({
      eventType: WhatsAppEventType.PollCreation,
      chatJid: "120363@g.us",
      actor: { displayName: null, phone: null, jid: "bot@s.whatsapp.net" },
      pollName: "Qui joue ?",
      selectedOptions: [],
      occurredAt: "2026-08-04T09:00:00.000Z",
    });
  });
});

describe("createSseHub", () => {
  it("broadcast appelle write sur chaque client", () => {
    const hub = createSseHub();
    const a = { write: vi.fn() };
    const b = { write: vi.fn() };
    hub.addClient(a);
    hub.addClient(b);

    const payload = toSsePayload({
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
    });

    hub.broadcast(payload);

    const chunk = `data: ${JSON.stringify(payload)}\n\n`;
    expect(a.write).toHaveBeenCalledWith(chunk);
    expect(b.write).toHaveBeenCalledWith(chunk);
    expect(hub.clientCount).toBe(2);
  });

  it("retire un client en erreur lors du broadcast", () => {
    const hub = createSseHub();
    const ok = { write: vi.fn() };
    const bad = {
      write: vi.fn(() => {
        throw new Error("broken");
      }),
    };
    hub.addClient(ok);
    hub.addClient(bad);

    hub.broadcast({
      eventType: WhatsAppEventType.PollCreation,
      chatJid: "g@g.us",
      actor: { displayName: null, phone: null, jid: "x@s.whatsapp.net" },
      pollName: "Q",
      selectedOptions: [],
      occurredAt: "2026-08-04T08:00:00.000Z",
    });

    expect(ok.write).toHaveBeenCalledOnce();
    expect(hub.clientCount).toBe(1);
  });
});
