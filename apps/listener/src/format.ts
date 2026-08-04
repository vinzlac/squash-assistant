import { WhatsAppEventType, type WhatsAppEvent } from "./whatsappEvents.js";

function actorLabel(event: WhatsAppEvent): string {
  return event.actor.displayName ?? event.actor.phone ?? event.actor.jid;
}

function groupLabel(event: WhatsAppEvent): string {
  return event.chat.name ?? event.chat.jid;
}

export function formatRelayMessage(event: WhatsAppEvent): string {
  const header = `[squash] ${groupLabel(event)}`;
  const who = `${event.eventType} — ${actorLabel(event)}`;
  switch (event.eventType) {
    case WhatsAppEventType.PollCreation:
      return [
        header,
        who,
        `sondage: ${event.data.name}`,
        `options: ${event.data.options.join(", ") || "(aucune)"}`,
      ].join("\n");
    case WhatsAppEventType.PollVoteCreation:
    case WhatsAppEventType.PollVoteUpdate:
    case WhatsAppEventType.PollVoteDeletion:
      return [
        header,
        who,
        `sondage: ${event.data.pollName}`,
        `options: ${event.data.selectedOptions.join(", ") || "(aucune)"}`,
      ].join("\n");
    default:
      return [header, who].join("\n");
  }
}
