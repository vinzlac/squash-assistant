import { WhatsAppEventType, type WhatsAppEvent } from "./whatsappEvents.js";

export interface SsePayload {
  eventType: string;
  chatJid: string;
  actor: { displayName: string | null; phone: string | null; jid: string };
  pollName: string | null;
  selectedOptions: string[];
  occurredAt: string;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function toSsePayload(event: WhatsAppEvent): SsePayload {
  const data = (event.data ?? {}) as Record<string, unknown>;
  let pollName: string | null = null;
  let selectedOptions: string[] = [];

  switch (event.eventType) {
    case WhatsAppEventType.PollCreation:
      pollName = typeof data.name === "string" ? data.name : null;
      break;
    case WhatsAppEventType.PollVoteCreation:
    case WhatsAppEventType.PollVoteUpdate:
    case WhatsAppEventType.PollVoteDeletion:
      pollName = typeof data.pollName === "string" ? data.pollName : null;
      selectedOptions = stringArray(data.selectedOptions);
      break;
  }

  return {
    eventType: event.eventType,
    chatJid: event.chat.jid,
    actor: {
      displayName: event.actor.displayName,
      phone: event.actor.phone,
      jid: event.actor.jid,
    },
    pollName,
    selectedOptions,
    occurredAt: event.occurredAt,
  };
}

export function createSseHub() {
  const clients = new Set<{ write: (chunk: string) => void; end?: () => void }>();
  return {
    addClient(client: { write: (chunk: string) => void }) {
      clients.add(client);
      return () => clients.delete(client);
    },
    broadcast(payload: SsePayload) {
      const chunk = `data: ${JSON.stringify(payload)}\n\n`;
      for (const c of [...clients]) {
        try {
          c.write(chunk);
        } catch {
          clients.delete(c);
        }
      }
    },
    get clientCount() {
      return clients.size;
    },
  };
}

export type SseHub = ReturnType<typeof createSseHub>;
