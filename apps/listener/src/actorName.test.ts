import { describe, expect, it, vi } from "vitest";
import { createActorNameResolver } from "./actorName.js";

const actor = { phone: "33600", displayName: "hugo mercier (WA)", jid: "33600@s.whatsapp.net" };

describe("createActorNameResolver", () => {
  it("renvoie le pseudo resa-squash et préfixe le téléphone par +", async () => {
    const lookup = vi.fn(async (_phone: string) => ({ found: true, userId: "u1", nickname: "Hugo", firstName: "Hugo" }));
    const resolve = createActorNameResolver({ lookup });
    expect(await resolve(actor)).toBe("Hugo");
    expect(lookup).toHaveBeenCalledWith("+33600");
  });

  it("retombe sur le prénom sans pseudo, jamais sur le nom de famille", async () => {
    const lookup = vi.fn(async () => ({ found: true, userId: "u1", firstName: "Hugo", lastName: "Mercier" }));
    expect(await createActorNameResolver({ lookup })(actor)).toBe("Hugo");
  });

  it("retombe sur le nom WhatsApp quand le joueur est introuvable", async () => {
    const lookup = vi.fn(async () => ({ found: false }));
    expect(await createActorNameResolver({ lookup })(actor)).toBe("hugo mercier (WA)");
  });

  it("retombe sur le nom WhatsApp quand resa-squash échoue", async () => {
    const lookup = vi.fn(async () => {
      throw new Error("boom");
    });
    const log = vi.fn();
    expect(await createActorNameResolver({ lookup, log })(actor)).toBe("hugo mercier (WA)");
    expect(log).toHaveBeenCalledOnce();
  });

  it("n'appelle pas resa-squash sans téléphone", async () => {
    const lookup = vi.fn(async () => ({ found: true, userId: "u1", nickname: "X" }));
    const name = await createActorNameResolver({ lookup })({ phone: null, displayName: null, jid: "a@lid" });
    expect(lookup).not.toHaveBeenCalled();
    expect(name).toBe("a@lid");
  });

  it("met en cache un joueur trouvé jusqu'à expiration du TTL", async () => {
    let now = 0;
    const lookup = vi.fn(async () => ({ found: true, userId: "u1", nickname: "Hugo" }));
    const resolve = createActorNameResolver({ lookup, ttlMs: 1000, now: () => now });
    await resolve(actor);
    await resolve(actor);
    expect(lookup).toHaveBeenCalledTimes(1);
    now = 1001;
    await resolve(actor);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("ne met pas en cache un échec", async () => {
    const lookup = vi.fn(async () => ({ found: false }));
    const resolve = createActorNameResolver({ lookup });
    await resolve(actor);
    await resolve(actor);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
