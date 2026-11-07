import type { BookedLine, LinesOutcome } from "./nodes/announce.js";
import type { BookingPlanGroup, ReservationFailure } from "./state.js";
import type { JokerSubstitution } from "../planning/jokerSubstitution.js";

type Booking = BookingPlanGroup["plan"]["proposedBookings"][number];

/**
 * Réservation réelle « lignes à risque d'abord » (ADR-039 point 6). Une ligne est à risque quand
 * elle porte le nom d'un prête-nom ou du joker : leurs crédits TeamR ne sont pas connaissables à
 * l'avance (ADR-028). Ces lignes sont réservées avant toutes les autres ; si l'une est refusée
 * malgré la cascade de substitution, les lignes à risque déjà prises sont annulées et le plan est
 * recalculé sans le nom refusé, avant qu'aucune ligne « sûre » n'ait consommé de crédits. Un refus
 * du joker ne rend donc jamais le résultat pire que le plan sans joker.
 */
export interface RiskyFirstDeps {
  reserveLines: (lines: Booking[]) => Promise<LinesOutcome>;
  cancel: (line: BookedLine) => Promise<void>;
  replan: (excludedBookerIds: ReadonlySet<string>) => Promise<BookingPlanGroup[]>;
}

export interface RiskyFirstInput {
  groups: BookingPlanGroup[];
  /** Prête-noms (volontaires + règle) et joker. */
  riskyNameIds: ReadonlySet<string>;
}

export interface RiskyFirstOutcome {
  groups: BookingPlanGroup[];
  substitutions: JokerSubstitution[];
  failures: ReservationFailure[];
  booked: BookedLine[];
  firstError: unknown;
}

/** Un recalcul suffit en pratique (un seul joker, peu de prête-noms) ; borne de sécurité. */
const MAX_REPLANS = 3;

function inWindow(groups: BookingPlanGroup[]): Booking[] {
  return groups.flatMap((g) => g.plan.proposedBookings.filter((b) => !g.outOfWindowSessionIds.includes(b.sessionId)));
}

/** Noms à écarter après les refus : fautifs identifiés, sinon les noms à risque des lignes refusées. */
function refusedNames(outcome: LinesOutcome, lines: Booking[], riskyNameIds: ReadonlySet<string>): Set<string> {
  const names = new Set(outcome.exhaustedIds);
  for (const failure of outcome.failures) {
    const failed = lines.find((b) => b.sessionId === failure.sessionId);
    const blamed = [failed?.userId, failed?.partnerId].filter((id): id is string => !!id && outcome.exhaustedIds.includes(id));
    if (blamed.length > 0) continue;
    for (const id of [failed?.userId, failed?.partnerId]) if (id && riskyNameIds.has(id)) names.add(id);
  }
  return names;
}

export async function reserveRiskyFirst(deps: RiskyFirstDeps, input: RiskyFirstInput): Promise<RiskyFirstOutcome> {
  const isRisky = (b: Booking) => [b.userId, b.partnerId].some((id) => !!id && input.riskyNameIds.has(id));
  let groups = input.groups;
  const excluded = new Set<string>();
  let risky: LinesOutcome | null = null;

  for (let replans = 0; ; replans += 1) {
    const riskyLines = inWindow(groups).filter(isRisky);
    if (riskyLines.length === 0) {
      risky = null;
      break;
    }
    risky = await deps.reserveLines(riskyLines);
    if (risky.failures.length === 0 || replans >= MAX_REPLANS) break;

    const refused = refusedNames(risky, riskyLines, input.riskyNameIds);
    const grows = [...refused].some((id) => !excluded.has(id));
    if (!grows) break;
    for (const id of refused) excluded.add(id);
    // Rien de « sûr » n'est encore pris : on rend les courts à risque et on repart d'un plan neuf.
    for (const line of risky.booked) await deps.cancel(line);
    groups = await deps.replan(excluded);
  }

  const riskyIds = new Set(risky?.booked.map((b) => b.sessionId).concat(risky.failures.map((f) => f.sessionId)) ?? []);
  const safe = await deps.reserveLines(inWindow(groups).filter((b) => !riskyIds.has(b.sessionId)));
  return {
    groups,
    substitutions: [...(risky?.substitutions ?? []), ...safe.substitutions],
    failures: [...(risky?.failures ?? []), ...safe.failures],
    booked: [...(risky?.booked ?? []), ...safe.booked],
    firstError: risky?.firstError ?? safe.firstError,
  };
}
