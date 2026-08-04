/** Fenêtre de flou codée en dur : le cron tire à H0, l'action réelle part dans [0, 1h). */
export const CRON_JITTER_WINDOW_MS = 60 * 60 * 1000;

/** Délai aléatoire uniforme dans [0, CRON_JITTER_WINDOW_MS). */
export function pickCronJitterMs(random: () => number = Math.random): number {
  return Math.floor(random() * CRON_JITTER_WINDOW_MS);
}

/**
 * Planifie `fn` après un jitter 0–1h. En mémoire uniquement : un redémarrage du
 * pod pendant l'attente annule le tir (acceptable tant que la fenêtre reste courte).
 */
export function scheduleWithCronJitter(
  label: string,
  fn: () => Promise<void>,
  random: () => number = Math.random,
  schedule: (cb: () => void, ms: number) => unknown = setTimeout,
): void {
  const delayMs = pickCronJitterMs(random);
  console.log(`[scheduler] ${label} — jitter ${Math.round(delayMs / 1000)}s (fenêtre 1h)`);
  schedule(() => {
    void fn().catch(() => {});
  }, delayMs);
}
