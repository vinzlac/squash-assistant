import { describe, expect, it, vi } from "vitest";

vi.mock("../mcp/resaSquash.js", () => ({ lookupPlayerByPhone: vi.fn() }));

const { buildUnresolvedVotersMessage, formatRelookupSummary, relookupUnresolvedVoters } = await import("./unresolvedVoters.js");
const { lookupPlayerByPhone } = await import("../mcp/resaSquash.js");

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

describe("relookupUnresolvedVoters (spec 2026-10-09 §3.3)", () => {
  const SUB = "Non, mais je peux prêter mon nom";
  const resaSquash = { client: {} as never, close: async () => {} };
  const found = (userId: string, firstName: string, lastName: string) => ({ found: true, userId, firstName, lastName });

  it("identifié → ajouté à son heure ou aux prête-noms, nom ajouté à voterNames ; inconnu ou sans téléphone → conservé", async () => {
    vi.mocked(lookupPlayerByPhone).mockImplementation(async (_c, phone) =>
      phone === "+33663892186" ? found("u-vince", "Vincent", "ALL") : phone === "+33600000009" ? found("u-henry", "Henry", "DUPONT") : { found: false },
    );
    const thomas = { name: "Thomas LECCIA", phone: "+33686870364", option: SUB };
    const noPhone = { name: "Sans Tel", phone: null, option: "10H30" };

    const result = await relookupUnresolvedVoters(resaSquash, {
      confirmedPlayerIdsByTime: { "10H30": ["u1"] },
      volunteerSubstituteIds: [],
      unresolvedVoters: [{ name: "Vince", phone: "+33663892186", option: SUB }, thomas, { name: "Henry", phone: "+33600000009", option: "10H30" }, noPhone],
      voterNames: { u1: "Hugo MERCIER" },
    });

    expect(result.confirmedPlayerIdsByTime).toEqual({ "10H30": ["u1", "u-henry"] });
    expect(result.volunteerSubstituteIds).toEqual(["u-vince"]);
    expect(result.unresolvedVoters).toEqual([thomas, noPhone]);
    expect(result.voterNames).toEqual({ u1: "Hugo MERCIER", "u-vince": "Vincent ALL", "u-henry": "Henry DUPONT" });
    expect(lookupPlayerByPhone).toHaveBeenCalledTimes(3);
    expect(formatRelookupSummary("Samedi", result)).toBe(
      "[Samedi] Recalcul : Vince identifié (prête-nom), Henry identifié (10H30), Thomas LECCIA toujours inconnu",
    );
  });

  it("identifié mais option qui n'est plus une heure du job : non ajouté au plan, conservé, libellé distinct", async () => {
    vi.mocked(lookupPlayerByPhone).mockResolvedValue(found("u-henry", "Henry", "DUPONT"));
    const henry = { name: "Henry", phone: "+33600000009", option: "9H45" };

    const result = await relookupUnresolvedVoters(resaSquash, {
      confirmedPlayerIdsByTime: { "10H30": ["u1"] },
      volunteerSubstituteIds: [],
      unresolvedVoters: [henry],
      voterNames: {},
    });

    expect(result.confirmedPlayerIdsByTime).toEqual({ "10H30": ["u1"] });
    expect(result.unresolvedVoters).toEqual([henry]);
    expect(result.voterNames).toEqual({});
    expect(formatRelookupSummary("Samedi", result)).toBe("[Samedi] Recalcul : Henry identifié mais option inconnue (« 9H45 »)");
  });

  it("recherche en erreur (panne resa-squash) : votant conservé, distingué d'un numéro inconnu, cause loguée", async () => {
    vi.mocked(lookupPlayerByPhone).mockRejectedValue(new Error("resa down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const voter = { name: "Vince", phone: "+33663892186", option: SUB };

    const result = await relookupUnresolvedVoters(resaSquash, {
      confirmedPlayerIdsByTime: {},
      volunteerSubstituteIds: [],
      unresolvedVoters: [voter],
      voterNames: {},
    });

    expect(result.unresolvedVoters).toEqual([voter]);
    expect(result.stillUnknown).toEqual([]);
    expect(result.lookupFailed).toEqual([{ name: "Vince", error: "resa down" }]);
    expect(formatRelookupSummary("Samedi", result)).toBe("[Samedi] Recalcul : Vince recherche en échec (resa down)");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Vince"), expect.any(Error));
    warn.mockRestore();
  });

  it("rien de retenté : pas de résumé", () => {
    expect(
      formatRelookupSummary("Samedi", {
        confirmedPlayerIdsByTime: {},
        volunteerSubstituteIds: [],
        unresolvedVoters: [],
        voterNames: {},
        identified: [],
        identifiedUnknownOption: [],
        stillUnknown: [],
        lookupFailed: [],
      }),
    ).toBeNull();
  });
});
