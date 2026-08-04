import { describe, expect, it } from "vitest";
import { isRelayTypeEnabled } from "./relaySettings.js";
import { WhatsAppEventType } from "./whatsappEvents.js";

const allEnabled = {
  id: "default",
  pollCreation: true,
  pollVoteCreation: true,
  pollVoteUpdate: true,
  pollVoteDeletion: true,
  updatedAt: new Date(),
};

describe("isRelayTypeEnabled", () => {
  it("active tous les types résa par défaut", () => {
    expect(isRelayTypeEnabled(allEnabled, WhatsAppEventType.PollCreation)).toBe(true);
    expect(isRelayTypeEnabled(allEnabled, WhatsAppEventType.PollVoteCreation)).toBe(true);
    expect(isRelayTypeEnabled(allEnabled, WhatsAppEventType.PollVoteUpdate)).toBe(true);
    expect(isRelayTypeEnabled(allEnabled, WhatsAppEventType.PollVoteDeletion)).toBe(true);
  });

  it("respecte chaque booléen individuellement", () => {
    expect(
      isRelayTypeEnabled({ ...allEnabled, pollVoteUpdate: false }, WhatsAppEventType.PollVoteUpdate),
    ).toBe(false);
    expect(
      isRelayTypeEnabled({ ...allEnabled, pollCreation: false }, WhatsAppEventType.PollCreation),
    ).toBe(false);
  });

  it("refuse les types hors périmètre résa", () => {
    expect(isRelayTypeEnabled(allEnabled, WhatsAppEventType.MessageCreation)).toBe(false);
  });
});
