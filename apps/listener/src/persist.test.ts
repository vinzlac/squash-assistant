import { describe, expect, it, vi } from "vitest";
import type { Database } from "@squash-assistant/db/client";
import { persistResaEvent } from "./persist.js";
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

function mockDb(insertImpl: () => Promise<void>): Database {
  const onConflictDoNothing = vi.fn().mockImplementation(insertImpl);
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });
  return { insert } as unknown as Database;
}

describe("persistResaEvent", () => {
  it("insère avec summary formaté et onConflictDoNothing sur eventId", async () => {
    const db = mockDb(async () => {});
    await persistResaEvent(db, event as never);
    expect(db.insert).toHaveBeenCalledOnce();
    const values = (db.insert as ReturnType<typeof vi.fn>).mock.results[0].value.values;
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "e1",
        eventType: WhatsAppEventType.PollVoteCreation,
        summary: expect.stringContaining("poll_vote_creation"),
        payload: event,
      }),
    );
    expect(values.mock.results[0].value.onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it("ne lève pas sur conflit eventId (onConflictDoNothing)", async () => {
    const db = mockDb(async () => {});
    await expect(persistResaEvent(db, event as never)).resolves.toBeUndefined();
  });

  it("propage les erreurs DB réelles", async () => {
    const db = mockDb(async () => {
      throw new Error("connection refused");
    });
    await expect(persistResaEvent(db, event as never)).rejects.toThrow("connection refused");
  });
});
