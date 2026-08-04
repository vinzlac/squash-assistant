import { isResaEventType, type WhatsAppEvent } from "./whatsappEvents.js";

export function shouldRelay(
  event: WhatsAppEvent,
  allowlist: ReadonlySet<string>,
  vincentAllGroupJid: string,
): boolean {
  if (event.chat.jid === vincentAllGroupJid) return false;
  if (!allowlist.has(event.chat.jid)) return false;
  return isResaEventType(event.eventType);
}
