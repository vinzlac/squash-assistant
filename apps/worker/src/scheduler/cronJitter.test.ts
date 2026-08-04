import { describe, expect, it, vi } from "vitest";
import {
  cronJitterWindowMs,
  pickCronJitterMs,
  scheduleWithCronJitter,
} from "./cronJitter.js";

describe("pickCronJitterMs", () => {
  it("retourne 0 si la fenêtre est nulle ou négative", () => {
    expect(pickCronJitterMs(0)).toBe(0);
    expect(pickCronJitterMs(-10)).toBe(0);
  });

  it("reste dans [0, windowMs)", () => {
    const windowMs = cronJitterWindowMs(60);
    expect(pickCronJitterMs(windowMs, () => 0)).toBe(0);
    const nearEnd = pickCronJitterMs(windowMs, () => 0.999999);
    expect(nearEnd).toBeGreaterThanOrEqual(0);
    expect(nearEnd).toBeLessThan(windowMs);
  });
});

describe("scheduleWithCronJitter", () => {
  it("appelle setTimeout avec le délai tiré puis exécute fn", async () => {
    const fn = vi.fn(async () => {});
    const schedule = vi.fn((cb: () => void, _ms: number) => {
      cb();
      return 0;
    });
    const windowMs = cronJitterWindowMs(60);
    scheduleWithCronJitter("test-rule poll", 60, fn, () => 0.5, schedule);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), Math.floor(0.5 * windowMs));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("planifie immédiatement si fenêtre 0", () => {
    const fn = vi.fn(async () => {});
    const schedule = vi.fn((cb: () => void, _ms: number) => {
      cb();
      return 0;
    });
    scheduleWithCronJitter("test-rule poll", 0, fn, () => 0.9, schedule);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 0);
  });
});
