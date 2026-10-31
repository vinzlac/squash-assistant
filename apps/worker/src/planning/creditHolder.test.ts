import { describe, expect, it } from "vitest";
import { McpToolError } from "../mcp/client.js";
import { identifyCreditHolder, refusedPlayerName } from "./creditHolder.js";

const refusal = (details: Record<string, unknown>, message = "refus") =>
  new McpToolError("reserve_slot", "PLAYER_BOOKING_LIMIT_REACHED", details, message);

describe("refusedPlayerName", () => {
  it("ignore teamr.name quand c'est un code d'erreur (« noCredits ») : le message fait foi", () => {
    expect(refusedPlayerName(refusal({ teamr: { name: "noCredits", message: "Joshua JACQUES-PHINERA a utilisé tous ses crédits." } }))).toBe(
      "Joshua JACQUES-PHINERA",
    );
  });

  it("repli sur teamr.name s'il ressemble à un nom de personne et que le message n'en cite aucun", () => {
    expect(refusedPlayerName(refusal({ teamr: { name: "Joshua J", message: "Refusé." } }))).toBe("Joshua J");
    expect(refusedPlayerName(refusal({ teamr: { name: "noCredits", message: "Refusé." } }))).toBeNull();
  });

  it("à défaut, lit le sujet du message TeamR", () => {
    expect(refusedPlayerName(refusal({ teamr: { message: "Joshua JACQUES-PHINERA a utilisé tous ses crédits. Vous avez le droit à deux réservations." } }))).toBe(
      "Joshua JACQUES-PHINERA",
    );
  });

  it("à défaut, lit le texte de l'erreur MCP", () => {
    expect(refusedPlayerName(refusal({}, "[{\"text\":\"Vincent LACOSTE a utilisé tous ses crédits. (noCredits)\"}]"))).toBe("Vincent LACOSTE");
  });

  it("aucun nom exploitable : null", () => {
    expect(refusedPlayerName(refusal({}, "noCredits"))).toBeNull();
  });
});

describe("identifyCreditHolder", () => {
  const joshua = { id: "joshua", firstName: "Joshua", lastName: "JACQUES-PHINERA" };
  const martin = { id: "martin", firstName: "Martin", lastName: "Dupont" };

  it("nom complet, accents et casse ignorés", () => {
    expect(identifyCreditHolder("JOSHUA jacques-phinera", [martin, joshua])).toBe("joshua");
    expect(identifyCreditHolder("Martín DUPONT", [martin, joshua])).toBe("martin");
  });

  it("nom abrégé par TeamR (« Joshua J »)", () => {
    expect(identifyCreditHolder("Joshua J", [martin, joshua])).toBe("joshua");
  });

  it("le prénom doit être exact : « Max » ne désigne pas « Maxime »", () => {
    expect(identifyCreditHolder("Max Dupont", [{ id: "maxime", firstName: "Maxime", lastName: "Dupont" }])).toBeNull();
  });

  it("un mot du nom de famille d'un autre joueur ne suffit pas (« Martin » ≠ « Paul Martinez »)", () => {
    expect(identifyCreditHolder("Martin", [{ id: "paul", firstName: "Paul", lastName: "Martinez" }])).toBeNull();
  });

  it("une correspondance exacte unique l'emporte sur les préfixes", () => {
    expect(
      identifyCreditHolder("Max Dupont", [
        { id: "max", firstName: "Max", lastName: "Dupont" },
        { id: "max2", firstName: "Max", lastName: "Dupontel" },
      ]),
    ).toBe("max");
  });

  it("aucun candidat ne correspond : null", () => {
    expect(identifyCreditHolder("Paul Durand", [martin, joshua])).toBeNull();
  });

  it("deux candidats correspondent (homonymes) : null, on ne devine pas", () => {
    expect(identifyCreditHolder("Martin D", [martin, { id: "martin2", firstName: "Martin", lastName: "Durand" }])).toBeNull();
  });

  it("noms inconnus côté resa-squash : jamais de correspondance", () => {
    expect(identifyCreditHolder("Joshua J", [{ id: "x", firstName: null, lastName: null }])).toBeNull();
  });
});
