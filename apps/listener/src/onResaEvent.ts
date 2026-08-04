import type { WhatsAppEvent } from "./whatsappEvents.js";

export interface OnResaEventDeps {
  relay: (event: WhatsAppEvent) => Promise<void>;
  broadcast?: (event: WhatsAppEvent) => void;
}

export async function onResaEvent(deps: OnResaEventDeps, event: WhatsAppEvent): Promise<void> {
  await deps.relay(event);
  if (deps.broadcast) {
    try {
      deps.broadcast(event);
    } catch (err) {
      console.error("[listener] broadcast SSE échoué", err);
    }
  }
}
