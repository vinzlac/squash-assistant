// Types WhatsApp events (contrat ADR-012 huddle-bot) — copie locale, pas d'import @huddle-bot/*.
// Subject NATS : homelab.whatsapp.<jid-sanitized> ; eventType uniquement dans le payload.

export enum WhatsAppEventType {
  MessageCreation = "message_creation",
  MessageEdition = "message_edition",
  MessageDeletion = "message_deletion",
  GroupCreation = "group_creation",
  PollCreation = "poll_creation",
  PollVoteCreation = "poll_vote_creation",
  PollVoteUpdate = "poll_vote_update",
  PollVoteDeletion = "poll_vote_deletion",
}

export function sanitizeWhatsAppJidForSubject(jid: string): string {
  return jid.replace(/[^a-zA-Z0-9-]/g, "_");
}

export function whatsAppEventSubject(chatJid: string): string {
  return `homelab.whatsapp.${sanitizeWhatsAppJidForSubject(chatJid)}`;
}

export interface WhatsAppActor {
  phone: string | null;
  displayName: string | null;
  jid: string;
}

export interface WhatsAppChatRef {
  jid: string;
  name: string | null;
  isGroup: boolean;
}

interface WhatsAppEventBase<T extends WhatsAppEventType, D> {
  eventId: string;
  eventType: T;
  occurredAt: string;
  chat: WhatsAppChatRef;
  actor: WhatsAppActor;
  data: D;
}

export type MessageCreationEvent = WhatsAppEventBase<
  WhatsAppEventType.MessageCreation,
  {
    whatsappMessageId: string;
    content: string;
  }
>;

export type MessageEditionEvent = WhatsAppEventBase<
  WhatsAppEventType.MessageEdition,
  {
    whatsappMessageId: string;
    previousContent: string | null;
    newContent: string;
  }
>;

export type MessageDeletionEvent = WhatsAppEventBase<
  WhatsAppEventType.MessageDeletion,
  {
    whatsappMessageId: string;
    content: string | null;
  }
>;

export type GroupCreationEvent = WhatsAppEventBase<
  WhatsAppEventType.GroupCreation,
  {
    subject: string | null;
    participantCount: number;
  }
>;

export type PollCreationEvent = WhatsAppEventBase<
  WhatsAppEventType.PollCreation,
  {
    whatsappMessageId: string;
    name: string;
    options: string[];
    allowMultiple: boolean;
  }
>;

interface PollVoteData {
  pollWhatsappMessageId: string;
  pollName: string;
  selectedOptions: string[];
  previousOptions: string[];
}

export type PollVoteCreationEvent = WhatsAppEventBase<
  WhatsAppEventType.PollVoteCreation,
  PollVoteData
>;
export type PollVoteUpdateEvent = WhatsAppEventBase<
  WhatsAppEventType.PollVoteUpdate,
  PollVoteData
>;
export type PollVoteDeletionEvent = WhatsAppEventBase<
  WhatsAppEventType.PollVoteDeletion,
  PollVoteData
>;

export type WhatsAppEvent =
  | MessageCreationEvent
  | MessageEditionEvent
  | MessageDeletionEvent
  | GroupCreationEvent
  | PollCreationEvent
  | PollVoteCreationEvent
  | PollVoteUpdateEvent
  | PollVoteDeletionEvent;

export type ResaEventType =
  | WhatsAppEventType.PollCreation
  | WhatsAppEventType.PollVoteCreation
  | WhatsAppEventType.PollVoteUpdate
  | WhatsAppEventType.PollVoteDeletion;

export const RESA_EVENT_TYPES = [
  WhatsAppEventType.PollCreation,
  WhatsAppEventType.PollVoteCreation,
  WhatsAppEventType.PollVoteUpdate,
  WhatsAppEventType.PollVoteDeletion,
] as const;

const RESA = new Set<string>(RESA_EVENT_TYPES);

export function isResaEventType(t: string): t is ResaEventType {
  return RESA.has(t);
}

const EVENT_TYPES = new Set<string>(Object.values(WhatsAppEventType));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function parseWhatsAppEvent(raw: unknown): WhatsAppEvent {
  if (!isRecord(raw)) {
    throw new Error("Invalid WhatsApp event: payload must be an object");
  }

  const { eventId, eventType, occurredAt, chat, actor, data } = raw;

  if (typeof eventId !== "string" || !eventId) {
    throw new Error("Invalid WhatsApp event: missing eventId");
  }
  if (typeof eventType !== "string" || !EVENT_TYPES.has(eventType)) {
    throw new Error("Invalid WhatsApp event: missing or unknown eventType");
  }
  if (typeof occurredAt !== "string" || !occurredAt) {
    throw new Error("Invalid WhatsApp event: missing occurredAt");
  }
  if (!isRecord(chat) || typeof chat.jid !== "string" || !chat.jid) {
    throw new Error("Invalid WhatsApp event: missing chat.jid");
  }
  if (!isRecord(actor)) {
    throw new Error("Invalid WhatsApp event: missing actor");
  }
  if (data === undefined || data === null) {
    throw new Error("Invalid WhatsApp event: missing data");
  }

  return raw as unknown as WhatsAppEvent;
}
