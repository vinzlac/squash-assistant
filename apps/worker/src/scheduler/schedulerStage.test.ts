import { describe, expect, it } from "vitest";
import { computeStage } from "./scheduler.js";

describe("computeStage", () => {
  it("classe une fermeture du club comme terminale avant de chercher un pollRequestId", () => {
    expect(computeStage(undefined, { clubClosed: true })).toBe("finished-club-closed");
  });
});
