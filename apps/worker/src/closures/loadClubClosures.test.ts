import { describe, expect, it } from "vitest";
import { loadClubClosuresForDate } from "./loadClubClosures.js";

describe("loadClubClosuresForDate", () => {
  it("retourne uniquement les bornes utiles des fermetures qui chevauchent la date", async () => {
    const startsAt = new Date("2026-08-14T22:00:00.000Z");
    const endsAt = new Date("2026-08-15T22:00:00.000Z");
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [{ id: "closure-1", startsAt, endsAt, label: "Jour férié", createdAt: new Date() }],
        }),
      }),
    };

    await expect(loadClubClosuresForDate(db as never, "2026-08-15")).resolves.toEqual([{ startsAt, endsAt }]);
  });
});
