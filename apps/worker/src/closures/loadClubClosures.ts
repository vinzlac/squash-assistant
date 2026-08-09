import { and, gt, lt } from "drizzle-orm";
import type { Database } from "@squash-assistant/db/client";
import { clubClosures } from "@squash-assistant/db/schema";
import { slotStartDateIsoHeuristicParis } from "../planning/teamrTime.js";
import type { ClosureInterval } from "./filterCandidateTimes.js";

/** Charge les fermetures qui chevauchent la journée Paris [00:00, 24:00). */
export async function loadClubClosuresForDate(db: Database, targetDate: string): Promise<ClosureInterval[]> {
  const dayStartIso = slotStartDateIsoHeuristicParis(targetDate, "00H00");
  const nextDay = new Date(`${targetDate}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextDate = nextDay.toISOString().slice(0, 10);
  const dayEndIso = slotStartDateIsoHeuristicParis(nextDate, "00H00");
  if (!dayStartIso || !dayEndIso) return [];

  const rows = await db
    .select()
    .from(clubClosures)
    .where(
      and(
        lt(clubClosures.startsAt, new Date(dayEndIso)),
        gt(clubClosures.endsAt, new Date(dayStartIso)),
      ),
    );

  return rows.map(({ startsAt, endsAt }) => ({ startsAt, endsAt }));
}
