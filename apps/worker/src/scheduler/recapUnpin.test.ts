import { describe, expect, it } from "vitest";
import { isRecapUnpinDue, isRecapUnpinStale } from "./recapUnpin.js";

// samedi 10 octobre 2026, Paris = UTC+2
const atParis = (minutes: number) => new Date(Date.UTC(2026, 9, 9, 22, 0) + minutes * 60_000);
const due = (targetDate: string, firstSlot: number | null, now: Date, cancelled = false) =>
  isRecapUnpinDue({ targetDate, firstReservedSlotMinutes: firstSlot, cancelled, now });

describe("isRecapUnpinDue (spec 2026-10-09 §2.3)", () => {
  it("jour du match : dû à l'heure du premier créneau réservé, pas avant", () => {
    expect(due("2026-10-10", 10 * 60 + 30, atParis(10 * 60 + 29))).toBe(false);
    expect(due("2026-10-10", 10 * 60 + 30, atParis(10 * 60 + 30))).toBe(true);
  });

  it("aucun créneau réservé : 23h59", () => {
    expect(due("2026-10-10", null, atParis(23 * 60 + 58))).toBe(false);
    expect(due("2026-10-10", null, atParis(23 * 60 + 59))).toBe(true);
  });

  it("rattrapage : date du match passée", () => {
    expect(due("2026-10-09", 10 * 60 + 30, atParis(0))).toBe(true);
  });

  it("match à venir : pas dû, sauf job annulé (désépinglage immédiat à retenter)", () => {
    expect(due("2026-10-15", null, atParis(12 * 60))).toBe(false);
    expect(due("2026-10-15", null, atParis(12 * 60), true)).toBe(true);
  });

  it("abandon : match passé depuis plus de 7 jours (épinglage 7d expiré)", () => {
    expect(isRecapUnpinStale("2026-10-03", atParis(12 * 60))).toBe(false); // il y a 7 jours pile
    expect(isRecapUnpinStale("2026-10-02", atParis(12 * 60))).toBe(true);
  });
});
