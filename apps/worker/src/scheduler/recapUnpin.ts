import { parisMinutesNow } from "./startReminder.js";
import { computeTargetDate } from "./weekKey.js";

/** Pas de créneau réservé : le récap reste épinglé jusqu'à 23h59 le jour du match (spec 2026-10-09 §2.3). */
export const RECAP_UNPIN_FALLBACK_MINUTES = 23 * 60 + 59;

/**
 * Le récap des inscrits doit-il être désépinglé maintenant ? Jour du match à l'heure du premier
 * créneau réservé (heure murale de Paris), 23h59 sans créneau, date passée (rattrapage pod arrêté),
 * ou job annulé (désépinglage immédiat à retenter).
 */
export function isRecapUnpinDue(input: {
  targetDate: string;
  firstReservedSlotMinutes: number | null;
  cancelled: boolean;
  now: Date;
}): boolean {
  if (input.cancelled) return true;
  const today = computeTargetDate(input.now, 0);
  if (input.targetDate < today) return true;
  if (input.targetDate > today) return false;
  return parisMinutesNow(input.now) >= (input.firstReservedSlotMinutes ?? RECAP_UNPIN_FALLBACK_MINUTES);
}

/** Au-delà, l'épinglage `7d` a expiré : inutile de réessayer un désépinglage peut-être impossible (message supprimé à la main, bot retiré). */
export const RECAP_UNPIN_ABANDON_DAYS = 7;

/** Match passé depuis plus de RECAP_UNPIN_ABANDON_DAYS jours (dates calendaires de Paris). */
export function isRecapUnpinStale(targetDate: string, now: Date): boolean {
  return targetDate < computeTargetDate(now, -RECAP_UNPIN_ABANDON_DAYS);
}
