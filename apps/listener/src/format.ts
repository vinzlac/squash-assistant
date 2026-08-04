import { WhatsAppEventType, type WhatsAppEvent } from "./whatsappEvents.js";

export class FormatRelayError extends Error {
  constructor(cause: unknown) {
    super("Impossible de formater l'événement pour relay");
    this.name = "FormatRelayError";
    this.cause = cause;
  }
}

function actorLabel(event: WhatsAppEvent): string {
  return event.actor?.displayName ?? event.actor?.phone ?? event.actor?.jid ?? "(inconnu)";
}

function groupLabel(event: WhatsAppEvent): string {
  return event.chat?.name ?? event.chat?.jid ?? "(inconnu)";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function formatRelayMessage(event: WhatsAppEvent): string {
  const header = `[squash] ${groupLabel(event)}`;
  const who = `${event.eventType} — ${actorLabel(event)}`;
  const data = (event.data ?? {}) as Record<string, unknown>;

  switch (event.eventType) {
    case WhatsAppEventType.PollCreation: {
      const name = typeof data.name === "string" ? data.name : "(inconnu)";
      const options = stringArray(data.options);
      return [
        header,
        who,
        `sondage: ${name}`,
        `options: ${options.join(", ") || "(aucune)"}`,
      ].join("\n");
    }
    case WhatsAppEventType.PollVoteCreation:
    case WhatsAppEventType.PollVoteUpdate:
    case WhatsAppEventType.PollVoteDeletion: {
      const pollName = typeof data.pollName === "string" ? data.pollName : "(inconnu)";
      const selectedOptions = stringArray(data.selectedOptions);
      return [
        header,
        who,
        `sondage: ${pollName}`,
        `options: ${selectedOptions.join(", ") || "(aucune)"}`,
      ].join("\n");
    }
    default:
      return [header, who].join("\n");
  }
}
