import { describe, expect, it, vi } from "vitest";
import { CRON_JITTER_WINDOW_MS, pickCronJitterMs, scheduleWithCronJitter } from "./cronJitter.js";

describe("pickCronJitterMs", () => {
  it("reste dans [0, fenêtre)", () => {
    expect(pickCronJitterMs(() => 0)).toBe(0);
    const nearEnd = pickCronJitterMs(() => 0.999999);
    expect(nearEnd).toBeGreaterThanOrEqual(0);
    expect(nearEnd).toBeLessThan(CRON_JITTER_WINDOW_MS);
  });
});

describe("scheduleWithCronJitter", () => {
  it("appelle setTimeout avec le délai tiré puis exécute fn", async () => {
    const fn = vi.fn(async () => {});
    const schedule = vi.fn((cb: () => void, _ms: number) => {
      cb();
      return 0;
    });
    scheduleWithCronJitter("test-rule poll", fn, () => 0.5, schedule);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), Math.floor(0.5 * CRON_JITTER_WINDOW_MS));
    expect(fn).toHaveBeenCalledOnce();
  });
});
