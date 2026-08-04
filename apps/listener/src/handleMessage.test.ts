import { describe, expect, it, vi } from "vitest";
import { handleJsMessage } from "./handleMessage.js";
import { WhatsAppEventType } from "./whatsappEvents.js";

function makeMsg(payload: unknown, deliveryCount = 1) {
  return {
    json: <T>() => payload as T,
    ack: vi.fn(),
    nak: vi.fn(),
    info: { deliveryCount },
  };
}

const squash = "group@g.us";
const vincent = "vincent@g.us";

describe("handleJsMessage", () => {
  it("ack sans relay si hors filtre", async () => {
    const onResa = vi.fn();
    const msg = makeMsg({
      eventId: "e",
      eventType: WhatsAppEventType.MessageCreation,
      occurredAt: "2026-08-04T08:00:00.000Z",
      chat: { jid: squash, name: "G", isGroup: true },
      actor: { phone: null, displayName: null, jid: "a@s.whatsapp.net" },
      data: { whatsappMessageId: "m", content: "hi" },
    });
    await handleJsMessage(msg, {
      allowlist: new Set([squash]),
      vincentAllGroupJid: vincent,
      onResaEvent: onResa,
    });
    expect(onResa).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it("ack après onResaEvent OK", async () => {
    const onResa = vi.fn(async () => {});
    const msg = makeMsg({
      eventId: "e",
      eventType: WhatsAppEventType.PollVoteCreation,
      occurredAt: "2026-08-04T08:00:00.000Z",
      chat: { jid: squash, name: "G", isGroup: true },
      actor: { phone: null, displayName: "A", jid: "a@s.whatsapp.net" },
      data: {
        pollWhatsappMessageId: "m",
        pollName: "Qui ?",
        selectedOptions: ["18H45"],
        previousOptions: [],
      },
    });
    await handleJsMessage(msg, {
      allowlist: new Set([squash]),
      vincentAllGroupJid: vincent,
      onResaEvent: onResa,
    });
    expect(onResa).toHaveBeenCalledOnce();
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it("nak avec backoff si onResaEvent échoue", async () => {
    const onResa = vi.fn(async () => {
      throw new Error("mcp down");
    });
    const msg = makeMsg(
      {
        eventId: "e",
        eventType: WhatsAppEventType.PollVoteCreation,
        occurredAt: "2026-08-04T08:00:00.000Z",
        chat: { jid: squash, name: "G", isGroup: true },
        actor: { phone: null, displayName: "A", jid: "a@s.whatsapp.net" },
        data: {
          pollWhatsappMessageId: "m",
          pollName: "Qui ?",
          selectedOptions: ["18H45"],
          previousOptions: [],
        },
      },
      2,
    );
    await handleJsMessage(msg, {
      allowlist: new Set([squash]),
      vincentAllGroupJid: vincent,
      onResaEvent: onResa,
    });
    expect(msg.nak).toHaveBeenCalledWith(15_000);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("ack poison pill JSON invalide", async () => {
    const msg = {
      json: () => {
        throw new Error("bad json");
      },
      ack: vi.fn(),
      nak: vi.fn(),
      info: { deliveryCount: 1 },
    };
    await handleJsMessage(msg, {
      allowlist: new Set(),
      vincentAllGroupJid: vincent,
      onResaEvent: vi.fn(),
    });
    expect(msg.ack).toHaveBeenCalledOnce();
  });
});
