import { describe, expect, it } from "vitest";
import { parseNotifyGroup } from "./notifyGroupForm";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(entries)) data.set(k, v);
  return data;
}

describe("parseNotifyGroup", () => {
  it("mode origin → null, même si un JID est présent", () => {
    expect(parseNotifyGroup(form({ m: "origin", j: "x@g.us" }), "m", "j")).toBeNull();
  });

  it("mode custom avec JID → le JID, sans espaces", () => {
    expect(parseNotifyGroup(form({ m: "custom", j: "  x@g.us " }), "m", "j")).toBe("x@g.us");
  });

  it("mode custom avec JID vide → null", () => {
    expect(parseNotifyGroup(form({ m: "custom", j: "   " }), "m", "j")).toBeNull();
  });

  it("champs absents → null (défaut origin)", () => {
    expect(parseNotifyGroup(form({}), "m", "j")).toBeNull();
  });

  it("deux couples de champs sont lus indépendamment", () => {
    const data = form({ am: "custom", aj: "annonce@g.us", cm: "origin", cj: "" });
    expect(parseNotifyGroup(data, "am", "aj")).toBe("annonce@g.us");
    expect(parseNotifyGroup(data, "cm", "cj")).toBeNull();
  });
});
