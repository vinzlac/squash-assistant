import { isSubstitutableReason, type JokerSubstitution } from "../planning/jokerSubstitution.js";
import type { AvailableSlot } from "../planning/courtAssignment.js";
import { parseTeamrTime } from "../planning/teamrTime.js";
import type { BookedLine, LinesOutcome } from "./nodes/announce.js";
import type { BookingPlanGroup, ReservationFailure } from "./state.js";

type Booking = BookingPlanGroup["plan"]["proposedBookings"][number];

/**
 * Réservation réelle « lignes à risque d'abord » (ADR-039 point 6). Une ligne est à risque quand
 * elle porte le nom d'un prête-nom ou du joker : leurs crédits TeamR ne sont pas connaissables à
 * l'avance (ADR-028). Ces lignes sont réservées avant toutes les autres ; si l'une est refusée
 * pour un motif de joueur (quota, pas réinscrit) malgré la cascade de substitution, le plan est
 * recalculé sans le nom refusé — courts déjà tenus compris — avant qu'aucune ligne « sûre » n'ait
 * consommé de crédits. Les lignes déjà prises identiques dans le nouveau plan sont gardées, les
 * autres annulées ; une annulation qui échoue garde la ligne telle quelle. Un refus du joker ne
 * rend donc jamais le résultat pire que le plan sans joker.
 */
export interface RiskyFirstDeps {
  reserveLines: (lines: Booking[]) => Promise<LinesOutcome>;
  cancel: (line: BookedLine) => Promise<void>;
  replan: (excludedBookerIds: ReadonlySet<string>, ownSlots: AvailableSlot[]) => Promise<BookingPlanGroup[]>;
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

/** Noms à écarter après des refus de joueur : fautifs identifiés, sinon les noms à risque de la ligne. */
function refusedNames(outcome: LinesOutcome, lines: Booking[], riskyNameIds: ReadonlySet<string>): Set<string> {
  const names = new Set<string>();
  for (const failure of outcome.failures) {
    if (!isSubstitutableReason(failure.reason)) continue;
    const failed = lines.find((b) => b.sessionId === failure.sessionId);
    const ids = [failed?.userId, failed?.partnerId].filter((id): id is string => !!id);
    const blamed = ids.filter((id) => outcome.exhaustedIds.includes(id));
    for (const id of blamed.length > 0 ? blamed : ids.filter((x) => riskyNameIds.has(x))) names.add(id);
  }
  return names;
}

const sameNames = (a: Booking, b: Pick<Booking, "userId" | "partnerId">) => a.userId === b.userId && a.partnerId === b.partnerId;

const byTime = (a: Booking, b: Booking) => (parseTeamrTime(a.slotTime) ?? 0) - (parseTeamrTime(b.slotTime) ?? 0) || a.court - b.court;

/**
 * Remplace (ou ajoute à son heure d'origine) la ligne d'un court que le job tient toujours, avec
 * un groupe de court pour ses joueurs (roster, compteur « sans créneau »).
 */
function withKeptLine(groups: BookingPlanGroup[], held: Held): BookingPlanGroup[] {
  const { line: kept, original, hour, members } = held;
  const line: Booking = { ...original, userId: kept.userId, partnerId: kept.partnerId };
  const present = groups.some((g) => g.plan.proposedBookings.some((b) => b.sessionId === kept.sessionId));
  return groups.map((g) => {
    const others = g.plan.proposedBookings.filter((b) => b.sessionId !== kept.sessionId);
    const holds = g.plan.proposedBookings.length !== others.length || (!present && g.startTime === hour);
    if (!holds) return { ...g, plan: { ...g.plan, proposedBookings: others } };
    const courtGroups = [...(g.plan.meta.courtGroups ?? []), { members, sessionIds: [kept.sessionId] }];
    return { ...g, plan: { ...g.plan, proposedBookings: [...others, line].sort(byTime), meta: { ...g.plan.meta, courtGroups } } };
  });
}

interface Held {
  line: BookedLine;
  original: Booking;
  hour: string;
  /** Joueurs des groupes de court du plan d'origine qui jouaient sur cette ligne. */
  members: string[];
}

/** Garde les courts identiques dans le nouveau plan, annule les autres (une annulation ratée garde le court). */
async function reconcile(deps: RiskyFirstDeps, next: BookingPlanGroup[], held: Held[]): Promise<{ groups: BookingPlanGroup[]; held: Held[] }> {
  let groups = next;
  const stillHeld: Held[] = [];
  for (const h of held) {
    const planned = inWindow(next).find((b) => b.sessionId === h.line.sessionId);
    // Même court, mêmes noms que la ligne prise ou que la ligne prévue avant substitution : on garde.
    if (planned && (sameNames(planned, h.line) || sameNames(planned, h.original))) {
      stillHeld.push(h);
      continue;
    }
    try {
      await deps.cancel(h.line);
    } catch {
      stillHeld.push(h);
      groups = withKeptLine(groups, h);
    }
  }
  return { groups, held: stillHeld };
}

export async function reserveRiskyFirst(deps: RiskyFirstDeps, input: RiskyFirstInput): Promise<RiskyFirstOutcome> {
  const isRisky = (b: Booking) => [b.userId, b.partnerId].some((id) => !!id && input.riskyNameIds.has(id));
  const hourOf = (groups: BookingPlanGroup[], sessionId: string) =>
    groups.find((g) => g.plan.proposedBookings.some((b) => b.sessionId === sessionId))?.startTime ?? "";
  const membersOf = (gs: BookingPlanGroup[], sessionId: string) => [
    ...new Set(gs.flatMap((g) => (g.plan.meta.courtGroups ?? []).filter((cg) => cg.sessionIds.includes(sessionId)).flatMap((cg) => cg.members))),
  ];
  let groups = input.groups;
  const excluded = new Set<string>();
  let held: Held[] = [];
  let substitutions: JokerSubstitution[] = [];
  let riskyFailures: ReservationFailure[] = [];
  let firstError: unknown;

  for (let replans = 0; ; replans += 1) {
    const heldIds = new Set(held.map((h) => h.line.sessionId));
    const riskyLines = inWindow(groups).filter((b) => isRisky(b) && !heldIds.has(b.sessionId));
    if (riskyLines.length === 0) break;
    const outcome = await deps.reserveLines(riskyLines);
    held = [
      ...held,
      ...outcome.booked.map((line) => ({
        line,
        original: riskyLines.find((b) => b.sessionId === line.sessionId)!,
        hour: hourOf(groups, line.sessionId),
        members: membersOf(groups, line.sessionId),
      })),
    ];
    substitutions = [...substitutions, ...outcome.substitutions];
    riskyFailures = outcome.failures;
    firstError ??= outcome.firstError;
    if (riskyFailures.length === 0 || replans >= MAX_REPLANS) break;

    const refused = refusedNames(outcome, riskyLines, input.riskyNameIds);
    if (![...refused].some((id) => !excluded.has(id))) break;
    for (const id of refused) excluded.add(id);
    let next: BookingPlanGroup[];
    try {
      const ownSlots = held.map((h) => ({ sessionId: h.original.sessionId, court: h.original.court, beginTime: h.original.slotTime, endTime: h.original.slotEndTime }));
      next = await deps.replan(excluded, ownSlots);
    } catch {
      // Recalcul impossible (resa-squash indisponible…) : on garde le plan et les courts tenus.
      break;
    }
    // Rien de « sûr » n'est encore pris : les refus de ce tour sont remplacés par le nouveau plan.
    ({ groups, held } = await reconcile(deps, next, held));
    riskyFailures = [];
  }

  const heldIds = new Set(held.map((h) => h.line.sessionId));
  const failedIds = new Set(riskyFailures.map((f) => f.sessionId));
  const safe = await deps.reserveLines(inWindow(groups).filter((b) => !heldIds.has(b.sessionId) && !failedIds.has(b.sessionId)));
  return {
    groups,
    substitutions: [...substitutions.filter((s) => heldIds.has(s.sessionId)), ...safe.substitutions],
    failures: [...riskyFailures, ...safe.failures],
    booked: [...held.map((h) => h.line), ...safe.booked],
    firstError: firstError ?? safe.firstError,
  };
}
