import { describe, expect, it } from "vitest";
import { playerAdminLabel, playerMessageName } from "./playerLabel.js";

describe("playerMessageName — nom d'un joueur dans un message WhatsApp/Telegram", () => {
  it("renvoie le pseudo, jamais le nom de famille", () => {
    expect(playerMessageName({ nickname: "Vince", firstName: "Vincent", lastName: "Lacoste" })).toBe("Vince");
  });

  it("retombe sur le prénom seul si le pseudo est absent ou vide (ancien MCP)", () => {
    expect(playerMessageName({ firstName: "Vincent", lastName: "Lacoste" })).toBe("Vincent");
    expect(playerMessageName({ nickname: "  ", firstName: " Vincent ", lastName: "Lacoste" })).toBe("Vincent");
    expect(playerMessageName({ nickname: null, firstName: "Vincent" })).toBe("Vincent");
  });

  it("renvoie une chaîne vide sans pseudo ni prénom — chaque message applique son propre repli", () => {
    expect(playerMessageName({ lastName: "Lacoste" })).toBe("");
    expect(playerMessageName({ nickname: null, firstName: null })).toBe("");
    expect(playerMessageName({})).toBe("");
  });
});

describe("playerAdminLabel — libellé d'un joueur dans l'UI admin", () => {
  it("« Pseudo (Prénom NOM) », nom de famille en majuscules", () => {
    expect(playerAdminLabel({ nickname: "Vince", firstName: "Vincent", lastName: "Lacoste" })).toBe("Vince (Vincent LACOSTE)");
  });

  it("sans pseudo, le prénom sert de pseudo", () => {
    expect(playerAdminLabel({ firstName: "Vincent", lastName: "Lacoste" })).toBe("Vincent (Vincent LACOSTE)");
    expect(playerAdminLabel({ nickname: "", firstName: "Vincent", lastName: "Lacoste" })).toBe("Vincent (Vincent LACOSTE)");
  });

  it("sans nom complet, le pseudo seul", () => {
    expect(playerAdminLabel({ nickname: "Vince" })).toBe("Vince");
    expect(playerAdminLabel({ nickname: "Vince", firstName: null, lastName: null })).toBe("Vince");
  });

  it("sans pseudo ni prénom, le nom complet seul ; rien du tout → chaîne vide", () => {
    expect(playerAdminLabel({ lastName: "Lacoste" })).toBe("LACOSTE");
    expect(playerAdminLabel({})).toBe("");
  });
});
