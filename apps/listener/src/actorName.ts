import { playerMessageName } from "@squash-assistant/db/playerLabel";
import type { PlayerLookup } from "./mcp/resaSquash.js";
import type { WhatsAppActor } from "./whatsappEvents.js";

const NAME_CACHE_TTL_MS = 10 * 60_000;

export interface ActorNameResolverDeps {
  lookup: (phone: string) => Promise<PlayerLookup>;
  ttlMs?: number;
  now?: () => number;
  log?: (message: string, err: unknown) => void;
}

function fallbackName(actor: WhatsAppActor): string {
  return actor.displayName ?? actor.phone ?? actor.jid;
}

/**
 * Nom affiché pour l'auteur d'un événement : le pseudo resa-squash (lookup par téléphone), sinon le
 * nom WhatsApp. Ne lève jamais — un resa-squash indisponible ne doit pas bloquer le relais.
 */
export function createActorNameResolver(deps: ActorNameResolverDeps) {
  const ttlMs = deps.ttlMs ?? NAME_CACHE_TTL_MS;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message, err) => console.error(`[listener] ${message}`, err));
  const cache = new Map<string, { name: string; expiresAt: number }>();

  return async (actor: WhatsAppActor): Promise<string> => {
    if (!actor.phone) return fallbackName(actor);
    const phone = actor.phone.startsWith("+") ? actor.phone : `+${actor.phone}`;

    const cached = cache.get(phone);
    if (cached && cached.expiresAt > now()) return cached.name;

    try {
      const lookup = await deps.lookup(phone);
      const name = lookup.found ? playerMessageName(lookup) : "";
      if (!name) return fallbackName(actor);
      cache.set(phone, { name, expiresAt: now() + ttlMs });
      return name;
    } catch (err) {
      log("lookup_player_by_phone échoué — repli sur le nom WhatsApp", err);
      return fallbackName(actor);
    }
  };
}
