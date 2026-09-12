import { slotStartDateIsoHeuristicParis } from "../planning/teamrTime.js";

export interface ClosureInterval {
  startsAt: Date;
  endsAt: Date;
  /** Libellé de la fermeture (raison), utilisé dans les messages WhatsApp. */
  label?: string | null;
}

function isClosed(instant: Date, closures: ClosureInterval[]): boolean {
  const t = instant.getTime();
  return closures.some((c) => c.startsAt.getTime() <= t && t < c.endsAt.getTime());
}

export function filterCandidateTimesByClosures(
  targetDate: string,
  candidateStartTimes: string[],
  closures: ClosureInterval[],
): { openTimes: string[]; closedTimes: string[] } {
  const openTimes: string[] = [];
  const closedTimes: string[] = [];
  for (const time of candidateStartTimes) {
    const iso = slotStartDateIsoHeuristicParis(targetDate, time);
    if (iso == null) {
      openTimes.push(time);
      continue;
    }
    if (isClosed(new Date(iso), closures)) closedTimes.push(time);
    else openTimes.push(time);
  }
  return { openTimes, closedTimes };
}
