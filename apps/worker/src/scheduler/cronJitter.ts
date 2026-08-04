/** Défaut historique (1 h) — aussi default SQL de `BookingRule.cronJitterWindowMinutes`. */
export const DEFAULT_CRON_JITTER_WINDOW_MINUTES = 60;

/** Plafond UI / upsert — au-delà, délai en mémoire trop fragile au redeploy. */
export const MAX_CRON_JITTER_WINDOW_MINUTES = 120;

/** Délai aléatoire uniforme dans [0, windowMs). Si windowMs ≤ 0 → 0. */
export function pickCronJitterMs(windowMs: number, random: () => number = Math.random): number {
  if (windowMs <= 0) return 0;
  return Math.floor(random() * windowMs);
}

export function cronJitterWindowMs(minutes: number): number {
  const clamped = Math.max(0, minutes);
  return clamped * 60 * 1000;
}

/**
 * Planifie `fn` après un jitter dans [0, windowMinutes). En mémoire uniquement :
 * un redémarrage du pod pendant l'attente annule le tir.
 */
export function scheduleWithCronJitter(
  label: string,
  windowMinutes: number,
  fn: () => Promise<void>,
  random: () => number = Math.random,
  schedule: (cb: () => void, ms: number) => unknown = setTimeout,
): void {
  const windowMs = cronJitterWindowMs(windowMinutes);
  const delayMs = pickCronJitterMs(windowMs, random);
  console.log(
    `[scheduler] ${label} — jitter ${Math.round(delayMs / 1000)}s (fenêtre ${windowMinutes} min)`,
  );
  schedule(() => {
    void fn().catch(() => {});
  }, delayMs);
}
