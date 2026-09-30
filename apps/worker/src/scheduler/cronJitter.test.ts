import { describe, expect, it, vi } from "vitest";
import {
  cronExpressionMinutesEarlier,
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

describe("cronExpressionMinutesEarlier", () => {
  it("avance le cron de 10 min sans changer le jour", () => {
    expect(cronExpressionMinutesEarlier("30 10 * * 2", 10)).toBe("20 10 * * 2");
    expect(cronExpressionMinutesEarlier("30 22 * * 4", 10)).toBe("20 22 * * 4");
  });

  it("recule d'un jour quand le décalage traverse minuit", () => {
    expect(cronExpressionMinutesEarlier("5 0 * * 2", 10)).toBe("55 23 * * 1");
    expect(cronExpressionMinutesEarlier("0 0 * * 0", 10)).toBe("50 23 * * 6");
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

  it("retire un délai différent à chaque appel (fenêtre ±10 min = 20 min)", () => {
    const fn = vi.fn(async () => {});
    const delays: number[] = [];
    const schedule = vi.fn((_cb: () => void, ms: number) => {
      delays.push(ms);
      return 0;
    });
    const windowMs = cronJitterWindowMs(20);
    scheduleWithCronJitter("r confirmationCron", 20, fn, () => 0, schedule);
    scheduleWithCronJitter("r confirmationCron", 20, fn, () => 0.5, schedule);
    expect(delays).toEqual([0, Math.floor(0.5 * windowMs)]);
    expect(delays[0]).not.toBe(delays[1]);
    expect(delays[1]!).toBeGreaterThanOrEqual(0);
    expect(delays[1]!).toBeLessThan(windowMs);
  });
});
