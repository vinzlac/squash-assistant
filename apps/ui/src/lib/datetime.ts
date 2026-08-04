/** Fuseau d'affichage unique de l'UI admin — indépendant du TZ du pod (UTC en prod). */
export const DISPLAY_TIMEZONE = "Europe/Paris";

const DEFAULT_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: DISPLAY_TIMEZONE,
};

/**
 * Formate un instant pour l'UI en heure Europe/Paris (fr-FR).
 * Accepte Date, ISO string, ou timestamp — renvoie une chaîne de repli si invalide.
 */
export function formatDateTimeParis(
  value: Date | string | number | null | undefined,
  options: Intl.DateTimeFormatOptions = DEFAULT_OPTIONS,
): string {
  if (value == null || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("fr-FR", { ...options, timeZone: DISPLAY_TIMEZONE });
}
