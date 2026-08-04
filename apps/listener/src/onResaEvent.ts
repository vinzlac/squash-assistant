import type { WhatsAppEvent } from "./whatsappEvents.js";

export interface OnResaEventDeps {
  relay: (event: WhatsAppEvent) => Promise<void>;
  // phase 2: wsBroadcast?: (event: WhatsAppEvent) => Promise<void>;
}

export async function onResaEvent(deps: OnResaEventDeps, event: WhatsAppEvent): Promise<void> {
  await deps.relay(event);
}
