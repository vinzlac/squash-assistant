import { shouldRelay } from "./filter.js";
import { parseWhatsAppEvent, type WhatsAppEvent } from "./whatsappEvents.js";

export const BACKOFF_STEPS_MS = [5_000, 15_000, 30_000, 60_000];

export interface AckableMsg {
  json<T>(): T;
  ack(): void;
  nak(millis?: number): void;
  info: { deliveryCount: number };
}

export interface HandleContext {
  allowlist: ReadonlySet<string>;
  vincentAllGroupJid: string;
  onResaEvent: (event: WhatsAppEvent) => Promise<void>;
}

function backoffMs(deliveryCount: number): number {
  return BACKOFF_STEPS_MS[Math.min(deliveryCount - 1, BACKOFF_STEPS_MS.length - 1)];
}

export async function handleJsMessage(msg: AckableMsg, ctx: HandleContext): Promise<void> {
  let event: WhatsAppEvent;
  try {
    event = parseWhatsAppEvent(msg.json());
  } catch (err) {
    console.error("[listener] payload invalide — ack", err);
    msg.ack();
    return;
  }

  if (!shouldRelay(event, ctx.allowlist, ctx.vincentAllGroupJid)) {
    msg.ack();
    return;
  }

  try {
    await ctx.onResaEvent(event);
    msg.ack();
  } catch (err) {
    const delay = backoffMs(msg.info.deliveryCount);
    console.error(`[listener] échec traitement (tentative=${msg.info.deliveryCount}) — nak ${delay}ms`, err);
    msg.nak(delay);
  }
}
