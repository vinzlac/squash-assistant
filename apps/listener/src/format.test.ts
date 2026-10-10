import { describe, expect, it } from "vitest";
import { extractPollDate, formatEventSummary, formatRelayMessage } from "./format.js";
import { WhatsAppEventType } from "./whatsappEvents.js";

describe("formatEventSummary", () => {
  it("formate un vote", () => {
    const text = formatEventSummary({
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
    const text = formatEventSummary({
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
    const text = formatEventSummary({
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

const voteEvent = (eventType: WhatsAppEventType, data: Record<string, unknown>) =>
  ({
    eventId: "v1",
    eventType,
    occurredAt: "2026-10-10T08:00:00.000Z",
    chat: { jid: "120363@g.us", name: "Le squash du samedi matin", isGroup: true },
    actor: { phone: "33600", displayName: "hugo mercier", jid: "33600@s.whatsapp.net" },
    data,
  }) as never;

const POLL_NAME = "Squash samedi 17 octobre à 10h30 ? (réponses jusqu'au lundi 12 octobre à 9h)";

describe("extractPollDate", () => {
  it("extrait la date d'un sondage à heure unique", () => {
    expect(extractPollDate(POLL_NAME)).toBe("samedi 17 octobre");
  });

  it("extrait la date d'un sondage multi-heures", () => {
    expect(extractPollDate("Squash samedi 17 octobre, à quelle heure : 10h30 / 12h ?")).toBe(
      "samedi 17 octobre",
    );
  });

  it("renvoie null quand le format est inconnu", () => {
    expect(extractPollDate("Qui joue mardi ?")).toBeNull();
  });
});

describe("formatRelayMessage", () => {
  it("formate un vote créé avec le pseudo et la date", () => {
    const text = formatRelayMessage(
      voteEvent(WhatsAppEventType.PollVoteCreation, { pollName: POLL_NAME, selectedOptions: ["10H30"] }),
      "Hugo",
    );
    expect(text).toBe("🗳️ Hugo a répondu 10H30 pour le samedi 17 octobre");
  });

  it("formate un changement de réponse", () => {
    const text = formatRelayMessage(
      voteEvent(WhatsAppEventType.PollVoteUpdate, { pollName: POLL_NAME, selectedOptions: ["10H30", "12H00"] }),
      "Hugo",
    );
    expect(text).toBe("🔄 Hugo a changé sa réponse : 10H30, 12H00 pour le samedi 17 octobre");
  });

  it("formate un retrait de réponse", () => {
    const text = formatRelayMessage(
      voteEvent(WhatsAppEventType.PollVoteDeletion, { pollName: POLL_NAME, selectedOptions: [] }),
      "Hugo",
    );
    expect(text).toBe("↩️ Hugo a retiré sa réponse pour le samedi 17 octobre");
  });

  it("retombe sur le nom du sondage quand la date est introuvable", () => {
    const text = formatRelayMessage(
      voteEvent(WhatsAppEventType.PollVoteCreation, { pollName: "Qui joue mardi ?", selectedOptions: ["19H30"] }),
      "Hugo",
    );
    expect(text).toBe("🗳️ Hugo a répondu 19H30 pour « Qui joue mardi ? »");
  });

  it("garde le format détaillé pour la création de sondage", () => {
    const text = formatRelayMessage(
      {
        eventId: "p1",
        eventType: WhatsAppEventType.PollCreation,
        occurredAt: "2026-10-10T08:00:00.000Z",
        chat: { jid: "120363@g.us", name: "G", isGroup: true },
        actor: { phone: null, displayName: null, jid: "bot@s.whatsapp.net" },
        data: { whatsappMessageId: "m", name: "Qui joue ?", options: ["18H45"], allowMultiple: false },
      } as never,
      "Bot",
    );
    expect(text).toContain("poll_creation");
    expect(text).toContain("options: 18H45");
  });
});
