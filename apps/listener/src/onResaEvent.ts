import type { ListenerRelaySettings } from "./relaySettings.js";
import { isRelayTypeEnabled } from "./relaySettings.js";
import type { WhatsAppEvent } from "./whatsappEvents.js";

export interface OnResaEventDeps {
  persist: (event: WhatsAppEvent) => Promise<void>;
  relay: (event: WhatsAppEvent) => Promise<void>;
  broadcast?: (event: WhatsAppEvent) => void;
  settings: ListenerRelaySettings;
}

export async function onResaEvent(deps: OnResaEventDeps, event: WhatsAppEvent): Promise<void> {
  await deps.persist(event);

  if (deps.broadcast) {
    try {
      deps.broadcast(event);
    } catch (err) {
      console.error("[listener] broadcast SSE échoué", err);
    }
  }

  if (isRelayTypeEnabled(deps.settings, event.eventType)) {
    await deps.relay(event);
  }
}
