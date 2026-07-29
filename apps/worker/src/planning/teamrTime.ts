import { parseTeamrTime } from "../graph/capacityPlanning.js";

export { parseTeamrTime };

/** Minutes depuis minuit → libellé TeamR (ex. 1125 → "18H45"). */
export function formatTeamrTimeFromMinutes(minsTotal: number): string {
  const h = Math.floor(minsTotal / 60);
  const m = minsTotal % 60;
  return `${h}H${String(m).padStart(2, "0")}`;
}

/**
 * Construit une date/heure ISO pour reserve_slot à partir du jour et du libellé TeamR (ex. 18H45).
 * Heuristique fuseau Europe/Paris : +02 avril-octobre, +01 sinon (DST imparfait mars/novembre).
 * Port fidèle de resa-squash (group-booking-rules.ts, slotStartDateIsoHeuristicParis).
 */
export function slotStartDateIsoHeuristicParis(ymd: string, timeLabel: string): string | null {
  const mins = parseTeamrTime(timeLabel);
  if (mins == null) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const month = Number(ymd.slice(5, 7));
  const offset = month >= 4 && month <= 10 ? "+02:00" : "+01:00";
  return `${ymd}T${pad(h)}:${pad(m)}:00${offset}`;
}
