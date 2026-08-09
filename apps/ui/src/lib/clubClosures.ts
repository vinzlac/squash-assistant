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
