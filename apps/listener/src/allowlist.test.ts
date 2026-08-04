import { describe, expect, it } from "vitest";
import { buildAllowlist, loadAllowlist } from "./allowlist.js";

const vincent = "120363424956785709@g.us";

describe("buildAllowlist", () => {
  it("retourne les JIDs enabled hors Vincent All", () => {
    const set = buildAllowlist(["group-a@g.us", vincent, "group-b@g.us"], vincent);
    expect(set.has("group-a@g.us")).toBe(true);
    expect(set.has("group-b@g.us")).toBe(true);
    expect(set.has(vincent)).toBe(false);
    expect(set.size).toBe(2);
  });

  it("retourne un Set vide si seul Vincent All", () => {
    expect(buildAllowlist([vincent], vincent).size).toBe(0);
  });
});

describe("loadAllowlist", () => {
  it("charge les JIDs enabled depuis booking_rules et exclut Vincent All", async () => {
    const rows = [
      { whatsappGroupJid: "group-a@g.us" },
      { whatsappGroupJid: vincent },
      { whatsappGroupJid: "group-b@g.us" },
    ];
    const db = {
      select: () => ({
        from: () => ({
          where: async () => rows,
        }),
      }),
    };
    const set = await loadAllowlist(db as never, vincent);
    expect(set.has("group-a@g.us")).toBe(true);
    expect(set.has("group-b@g.us")).toBe(true);
    expect(set.has(vincent)).toBe(false);
  });
});
