import type { BookingPlanGroup } from "../graph/state.js";
import type { BookingRule } from "../config.js";
import type { CourtGroup, GroupBookingPlan } from "../mcp/resaSquash.js";
import { SQUASH_SLOT_MINUTES } from "./constants.js";
import type { SlotPlan } from "./slotPlanner.js";
import { parseTeamrTime, slotStartDateIsoHeuristicParis } from "./teamrTime.js";

/**
 * Remet le plan créneau par créneau (slotPlanner.ts) dans le format par heure de vote attendu par
 * l'annonce, le roster, le Telegram et l'UI (`BookingPlanGroup[]`). Une suite de créneaux
 * consécutifs sur un même court (« session ») appartient à l'heure de vote la plus tardive de ses
 * joueurs au moment où elle s'ouvre : le court 3 ouvert à 19H30 pour Tin est le court de 19H30.
 */

type Booking = GroupBookingPlan["proposedBookings"][number];

interface Session {
  court: number;
  hour: string;
  lastMinutes: number;
  members: Set<string>;
  bookings: Booking[];
  rotating: Set<string>;
  lastPlayers: Set<string>;
}

export interface PlanGroupsInput {
  rule: BookingRule;
  targetDate: string;
  confirmedPlayerIdsByTime: Record<string, string[]>;
  voteTimeOf: ReadonlyMap<string, string>;
  plan: SlotPlan;
  lenderIds: ReadonlySet<string>;
  nameBlockedIds: ReadonlySet<string>;
}

function buildSessions(input: PlanGroupsInput, warnings: string[]): Session[] {
  const order = (time: string) => input.rule.candidateStartTimes.indexOf(time);
  const sessions: Session[] = [];
  const open = new Map<number, Session>();
  for (const slot of input.plan.slots) {
    const minutes = parseTeamrTime(slot.time) ?? 0;
    for (const c of slot.courts) {
      let session = open.get(c.court);
      // Nouvelle session si le court n'était pas pris au créneau précédent, ou si aucun de ses
      // joueurs n'y était déjà (un autre groupe prend la suite sur le même court).
      const continues = session && session.lastMinutes + SQUASH_SLOT_MINUTES === minutes && c.players.some((id) => session!.lastPlayers.has(id));
      if (!session || !continues) {
        const hours = c.players.map((id) => input.voteTimeOf.get(id)!).sort((a, b) => order(b) - order(a));
        session = { court: c.court, hour: hours[0]!, lastMinutes: minutes, members: new Set(), bookings: [], rotating: new Set(), lastPlayers: new Set() };
        sessions.push(session);
        open.set(c.court, session);
      }
      session.lastMinutes = minutes;
      session.lastPlayers = new Set(c.players);
      for (const id of c.players) session.members.add(id);
      if (c.players.length > 2) for (const id of c.players) session.rotating.add(id);
      session.bookings.push({
        sessionId: c.slot.sessionId,
        userId: c.userId,
        partnerId: c.partnerId,
        startDate: slotStartDateIsoHeuristicParis(input.targetDate, c.slot.beginTime) ?? undefined,
        court: c.court,
        slotTime: c.slot.beginTime,
        slotEndTime: c.slot.endTime,
        groupId: input.rule.resaSquashGroupId,
      });
      warnings.push(...lineWarnings(input, c.players, c.userId, c.partnerId, c.court, slot.time));
    }
    if (slot.sittingOut.length > 0 && slot.courts.length > 0) {
      warnings.push(`${slot.time} : ${slot.sittingOut.join(", ")} sans court sur ce créneau (pas assez de courts ou de noms pour réserver).`);
    }
  }
  for (const s of sessions) {
    if (s.rotating.size > 0) {
      warnings.push(`Effectif impair : rotation à 3 sur le court ${s.court} (${[...s.rotating].join(", ")}), les joueurs s'arrangent entre eux pour tourner.`);
    }
  }
  return sessions;
}

function lineWarnings(input: PlanGroupsInput, players: string[], userId: string, partnerId: string, court: number, time: string): string[] {
  const out: string[] = [];
  const cause = players.some((id) => input.nameBlockedIds.has(id))
    ? "pas réinscrit pour la saison"
    : `plafond ${input.rule.maxDailyReservationsPerPlayer} résas/jour des joueurs atteint`;
  for (const id of [userId, partnerId]) {
    if (id === input.rule.jokerBookerId && !input.voteTimeOf.has(id)) out.push(`Court ${court} (${time}) : ${cause} — réservation au nom du joker ${id}.`);
    else if (input.lenderIds.has(id)) out.push(`Court ${court} (${time}) : ${cause} — réservation au nom du prête-nom ${id}.`);
  }
  return out;
}

/** Sessions d'une autre heure où jouent des joueurs de cette heure : elles comptent pour son roster. */
function hostedCourtGroups(input: PlanGroupsInput, hour: string, own: Session[], all: Session[]): CourtGroup[] {
  const ids = input.confirmedPlayerIdsByTime[hour] ?? [];
  return all
    .filter((s) => !own.includes(s))
    .map((s) => ({ members: ids.filter((id) => s.members.has(id)), sessionIds: s.bookings.map((b) => b.sessionId) }))
    .filter((g) => g.members.length > 0);
}

function groupPlan(input: PlanGroupsInput, hour: string, sessions: Session[], warnings: string[], hosted: CourtGroup[]): GroupBookingPlan {
  const bookings = sessions
    .flatMap((s) => s.bookings)
    .sort((a, b) => (parseTeamrTime(a.slotTime) ?? 0) - (parseTeamrTime(b.slotTime) ?? 0) || a.court - b.court);
  const courtGroups: CourtGroup[] = [
    ...sessions.map((s) => ({ members: [...s.members], sessionIds: s.bookings.map((b) => b.sessionId) })),
    ...hosted,
  ];
  const hourPlayers = input.confirmedPlayerIdsByTime[hour] ?? [];
  const slotsOf = (id: string) => (input.plan.effectiveMinutes.get(id) ?? 0) / SQUASH_SLOT_MINUTES;
  const played = hourPlayers.map(slotsOf);
  return {
    dryRun: true,
    proposedBookings: bookings,
    warnings,
    meta: {
      courtsNeeded: new Set(sessions.map((s) => s.court)).size,
      roundsPlanned: bookings.length,
      dryRun: true,
      groupLabel: input.rule.id,
      recurringWeekday: new Date(input.targetDate).getDay(),
      recurringStartTime: hour,
      slotsPerPlayer: bookings.length > 0 ? 1 : 0,
      groupMinSlotsPerPlayer: played.length > 0 ? Math.min(...played) : 0,
      groupMaxSlotsPerPlayer: played.length > 0 ? Math.max(...played) : 0,
      pairCount: bookings.length,
      rotatingPlayerIds: sessions.flatMap((s) => [...s.rotating]),
      courtGroups,
    },
  };
}

function hourWarnings(input: PlanGroupsInput, hour: string, own: Session[], all: Session[]): string[] {
  if (own.length > 0) return [];
  const ids = input.confirmedPlayerIdsByTime[hour] ?? [];
  const host = all.find((s) => ids.some((id) => s.members.has(id)));
  if (host) {
    const merged = ids.filter((id) => host.members.has(id));
    return [`Joueur(s) ${merged.join(", ")} fusionné(s) sur la session ${host.hour} (court ${host.court}) — pas de plan séparé à ${hour}.`];
  }
  return [`Pas assez de joueurs confirmés à ${hour} (${ids.length}/${input.rule.minPlayersPerCourt} requis) pour proposer un créneau.`];
}

export function toBookingPlanGroups(input: PlanGroupsInput): BookingPlanGroup[] {
  const lineNotes: string[] = [];
  const sessions = buildSessions(input, lineNotes);
  const hours = input.rule.candidateStartTimes;
  const playersOf = (hour: string) => input.confirmedPlayerIdsByTime[hour] ?? [];
  const isPlayerNote = (w: string, ids: readonly string[]) => ids.some((id) => w.startsWith(`${id} :`));
  const allPlayers = hours.flatMap(playersOf);
  // Notes générales (lignes au nom d'un prête-nom, rotations, manque de noms) : sur la 1re heure qui joue.
  const anchorHour =
    hours.find((h) => sessions.some((s) => s.hour === h)) ?? hours.find((h) => playersOf(h).length > 0) ?? hours[0];
  const generalNotes = [...lineNotes, ...input.plan.warnings.filter((w) => !isPlayerNote(w, allPlayers))];
  return hours.map((hour) => {
    const own = sessions.filter((s) => s.hour === hour);
    const playerNotes = input.plan.warnings.filter((w) => isPlayerNote(w, playersOf(hour)));
    const warnings = [...hourWarnings(input, hour, own, sessions), ...(hour === anchorHour ? generalNotes : []), ...playerNotes];
    const plan = groupPlan(input, hour, own, warnings, hostedCourtGroups(input, hour, own, sessions));
    // La fenêtre (ADR-014) est déjà appliquée joueur par joueur par le planificateur : aucune
    // ligne planifiée n'est hors fenêtre, quelle que soit l'heure à laquelle sa session est rattachée.
    return { startTime: hour, plan, outOfWindowSessionIds: [] };
  });
}
