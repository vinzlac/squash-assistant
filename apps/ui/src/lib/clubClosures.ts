import { asc, eq } from "drizzle-orm";
import { clubClosures, type ClubClosure } from "@squash-assistant/db/schema";
import { getDb } from "./db";

export type { ClubClosure };

export async function listClubClosures(): Promise<ClubClosure[]> {
  return getDb().select().from(clubClosures).orderBy(asc(clubClosures.startsAt));
}

export async function createClubClosure(input: {
  startsAt: Date;
  endsAt: Date;
  label: string | null;
}): Promise<void> {
  if (!(input.endsAt.getTime() > input.startsAt.getTime())) {
    throw new Error("endsAt must be after startsAt");
  }
  await getDb().insert(clubClosures).values({
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    label: input.label,
  });
}

export async function deleteClubClosure(id: string): Promise<void> {
  await getDb().delete(clubClosures).where(eq(clubClosures.id, id));
}

/** datetime-local "YYYY-MM-DDTHH:mm" interprété Europe/Paris (heuristique DST mois). */
export function parisLocalInputToDate(local: string): Date {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new Error(`invalid datetime-local: ${local}`);
  const [, ymd, hh, mm] = match;
  const month = Number(ymd!.slice(5, 7));
  const offset = month >= 4 && month <= 10 ? "+02:00" : "+01:00";
  return new Date(`${ymd}T${hh}:${mm}:00${offset}`);
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Ajoute N jours civils à un YMD (midi UTC pour éviter les bascules DST). */
export function addCalendarDaysYmd(ymd: string, days: number): string {
  if (!YMD_RE.test(ymd)) throw new Error(`invalid date: ${ymd}`);
  const d = new Date(`${ymd}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Journée(s) civiles inclusives Europe/Paris → intervalle [startsAt, endsAt)
 * avec bornes à minuit Paris (endsAt = minuit du lendemain du dernier jour).
 */
export function parisWholeDaysToInterval(
  startYmd: string,
  endYmdInclusive: string,
): { startsAt: Date; endsAt: Date } {
  if (!YMD_RE.test(startYmd) || !YMD_RE.test(endYmdInclusive)) {
    throw new Error("invalid date");
  }
  if (endYmdInclusive < startYmd) {
    throw new Error("end date before start date");
  }
  const startsAt = parisLocalInputToDate(`${startYmd}T00:00`);
  const endsAt = parisLocalInputToDate(`${addCalendarDaysYmd(endYmdInclusive, 1)}T00:00`);
  return { startsAt, endsAt };
}

/** True si l'intervalle est exactement une ou plusieurs journées civiles (minuit→minuit Paris). */
export function isWholeDayParisInterval(startsAt: Date, endsAt: Date): boolean {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = (d: Date) => {
    const map = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
    return {
      ymd: `${map.year}-${map.month}-${map.day}`,
      hm: `${map.hour}:${map.minute}`,
    };
  };
  const start = parts(startsAt);
  const end = parts(endsAt);
  if (start.hm !== "00:00" || end.hm !== "00:00") return false;
  return end.ymd > start.ymd;
}

/** Libellé d'affichage pour une fermeture journée entière, sinon null. */
export function formatWholeDayParisLabel(startsAt: Date, endsAt: Date): string | null {
  if (!isWholeDayParisInterval(startsAt, endsAt)) return null;
  const dayFmt = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const startLabel = dayFmt.format(startsAt);
  // Dernier jour inclus = veille de endsAt (minuit)
  const lastInclusive = new Date(endsAt.getTime() - 1);
  const endLabel = dayFmt.format(lastInclusive);
  if (startLabel === endLabel) return `Journée entière — ${startLabel}`;
  return `Journées entières — ${startLabel} → ${endLabel}`;
}
