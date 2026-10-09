import { describe, expect, it } from "vitest";
import { buildUnresolvedVotersMessage } from "./unresolvedVoters.js";

describe("buildUnresolvedVotersMessage (spec 2026-10-09 §3.1)", () => {
  it("liste chaque votant avec sa cause et son option, puis l'action attendue", () => {
    const text = buildUnresolvedVotersMessage("squash-samedi-matin v2", [
      { name: "Vince", phone: "+33663892186", option: "Non, mais je peux prêter mon nom" },
      { name: "Henry", phone: null, option: "10H30" },
    ]);
    expect(text).toBe(
      "[squash-samedi-matin v2] ⚠️ 2 votant(s) non identifié(s) — impossible de savoir qui c'est, exclu(s) du plan :\n" +
        "  • Vince (+33663892186, numéro inconnu de resa-squash) — « Non, mais je peux prêter mon nom »\n" +
        "  • Henry (pas de numéro WhatsApp) — « 10H30 »\n" +
        "→ Associer ce numéro à leur compte TeamR/resa-squash, puis « Recalculer le plan » avant le go.",
    );
  });
});
