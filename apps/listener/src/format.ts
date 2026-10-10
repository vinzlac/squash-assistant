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

/** Résumé technique stocké en base (`whatsapp_resa_events.summary`) et affiché dans l'UI admin. */
export function formatEventSummary(event: WhatsAppEvent): string {
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

/** « Squash samedi 17 octobre à 10h30 ? » ou « Squash samedi 17 octobre, à quelle heure : … ? » (pollQuestion.ts). */
const POLL_DATE_PATTERN = /^Squash\s+(.+?)(?:,\s*à quelle heure|\s+à\s+\d)/i;

export function extractPollDate(pollName: string): string | null {
  return POLL_DATE_PATTERN.exec(pollName)?.[1]?.trim() || null;
}

const VOTE_EMOJI = {
  [WhatsAppEventType.PollVoteCreation]: "🗳️",
  [WhatsAppEventType.PollVoteUpdate]: "🔄",
  [WhatsAppEventType.PollVoteDeletion]: "↩️",
} as const;

/** Message posté dans Vincent All ; `actorName` est le pseudo resa-squash déjà résolu. */
export function formatRelayMessage(event: WhatsAppEvent, actorName: string): string {
  if (
    event.eventType !== WhatsAppEventType.PollVoteCreation &&
    event.eventType !== WhatsAppEventType.PollVoteUpdate &&
    event.eventType !== WhatsAppEventType.PollVoteDeletion
  ) {
    return formatEventSummary(event);
  }

  const data: Partial<typeof event.data> = event.data ?? {};
  const pollName = typeof data.pollName === "string" ? data.pollName : "(inconnu)";
  const options = stringArray(data.selectedOptions).join(", ") || "(aucune)";
  const date = extractPollDate(pollName);
  const target = date ? `pour le ${date}` : `pour « ${pollName} »`;
  const emoji = VOTE_EMOJI[event.eventType];

  switch (event.eventType) {
    case WhatsAppEventType.PollVoteUpdate:
      return `${emoji} ${actorName} a changé sa réponse : ${options} ${target}`;
    case WhatsAppEventType.PollVoteDeletion:
      return `${emoji} ${actorName} a retiré sa réponse ${target}`;
    default:
      return `${emoji} ${actorName} a répondu ${options} ${target}`;
  }
}
