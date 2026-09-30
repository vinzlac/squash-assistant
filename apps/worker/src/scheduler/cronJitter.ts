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
 * Décale une expression node-cron (5 champs, jour en dernier) de `minutes` vers le passé.
 * Appelée par cronRegistry pour la confirmation : le cron sonne 10 min avant l'heure,
 * puis scheduleWithCronJitter attend un délai aléatoire dans [0, 20 min).
 * L'envoi tombe ainsi dans [heure − 10 min, heure + 10 min). Le jour recule si on traverse minuit.
 */
export function cronExpressionMinutesEarlier(expr: string, minutes: number): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5 || minutes < 0) {
    throw new Error(`Expression cron invalide : ${expr}`);
  }
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  const weekday = Number(parts[4]);
  if (![minute, hour, weekday].every((n) => Number.isInteger(n))) {
    throw new Error(`Expression cron invalide : ${expr}`);
  }
  let total = hour * 60 + minute - minutes;
  let dayDelta = 0;
  while (total < 0) {
    total += 24 * 60;
    dayDelta -= 1;
  }
  const newWeekday = (((weekday + dayDelta) % 7) + 7) % 7;
  return `${total % 60} ${Math.floor(total / 60)} ${parts[2]} ${parts[3]} ${newWeekday}`;
}

/**
 * Planifie `fn` après un jitter dans [0, windowMinutes). En mémoire uniquement :
 * un redémarrage du pod pendant l'attente annule le tir.
 * Chaque appel retire un nouveau délai via `random` : rien n'est mémorisé d'un tir à l'autre.
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
