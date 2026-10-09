import { describe, expect, it } from "vitest";
import { resaMemberAdminLabel } from "./resaSquash";

describe("resaMemberAdminLabel — membre resa-squash dans l'UI admin (/players, /listener)", () => {
  const member = { user_id: "u1", first_name: "Vincent", last_name: "Lacoste" };

  it("« Pseudo (Prénom NOM) »", () => {
    expect(resaMemberAdminLabel({ ...member, nickname: "Vince" })).toBe("Vince (Vincent LACOSTE)");
  });

  it("sans pseudo (MCP antérieur) : le prénom tient lieu de pseudo", () => {
    expect(resaMemberAdminLabel(member)).toBe("Vincent (Vincent LACOSTE)");
  });

  it("aucun nom : chaîne vide (chaque page garde son repli)", () => {
    expect(resaMemberAdminLabel({ user_id: "u1", first_name: "", last_name: "" })).toBe("");
  });
});
