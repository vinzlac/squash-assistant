import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parisLocalInputToDate } from "./clubClosures";

describe("parisLocalInputToDate", () => {
  it("utilise l'heure d'été d'avril à octobre", () => {
    assert.equal(parisLocalInputToDate("2026-08-09T18:45").toISOString(), "2026-08-09T16:45:00.000Z");
  });

  it("utilise l'heure d'hiver de novembre à mars", () => {
    assert.equal(parisLocalInputToDate("2026-01-09T18:45").toISOString(), "2026-01-09T17:45:00.000Z");
  });

  it("rejette une valeur datetime-local invalide", () => {
    assert.throws(() => parisLocalInputToDate("2026-08-09 18:45"), /invalid datetime-local/);
  });
});
