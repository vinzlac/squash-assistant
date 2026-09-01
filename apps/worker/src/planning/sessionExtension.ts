// apps/worker/src/planning/sessionExtension.ts
import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import type { AvailableSlot } from "./courtAssignment.js";
import { computeRoundsNeededForMembers, orderMembersByDemand } from "./groups.js";
import { resolvePlayerPlaySlots, type PlayerPlaySlotsMap, type PlaySlotsDefaults } from "./playerPlaySlots.js";
import { formatTeamrTimeFromMinutes, parseTeamrTime, slotStartDateIsoHeuristicParis } from "./teamrTime.js";
import { formatPairReplacement, resolveBookablePair } from "./jokerSubstitution.js";

export interface OngoingSession {
  court: number;
  /** Heure candidate qui a ouvert la session (pour la fenêtre availabilityWindowHours). */
  anchorStartTime: string;
  /** Joueurs réels confirmés sur ce court (pas les prête-noms TeamR) — 2 ou 3. */
  members: string[];
  /** Nombre de rounds déjà réservés sur ce court. */
  roundsBooked: number;
  /** Cible actuelle (recalculée si des late joiners rejoignent via extendSessionForLateJoiners). */
  roundsNeeded: number;
  proposedBookings: GroupBookingPlan["proposedBookings"];
  groupIndex: number;
}

function lastSlotEndTime(bookings: GroupBookingPlan["proposedBookings"], court: number): string | null {
  let best: string | null = null;
  let bestMin = -1;
  for (const b of bookings) {
    if (b.court !== court) continue;
    const end = parseTeamrTime(b.slotEndTime);
    if (end != null && end > bestMin) {
      bestMin = end;
      best = b.slotEndTime;
    }
  }
  return best;
}

function sessionCoversJoinTime(session: OngoingSession, timeKey: string): boolean {
  const joinMin = parseTeamrTime(timeKey);
  if (joinMin == null) return false;
  const anchor = parseTeamrTime(session.anchorStartTime);
  if (anchor == null) return false;
  if (joinMin < anchor) return false;
  const lastEnd = lastSlotEndTime(session.proposedBookings, session.court);
  if (!lastEnd) return true;
  const endMin = parseTeamrTime(lastEnd);
  return endMin != null && joinMin <= endMin;
}

function withinAvailabilityWindow(anchorStartTime: string, timeKey: string, windowHours: number): boolean {
  const anchor = parseTeamrTime(anchorStartTime);
  const t = parseTeamrTime(timeKey);
  if (anchor == null || t == null) return true;
  return t <= anchor + windowHours * 60;
}

/** Extrait une session par court à partir d'un plan calculé pour une heure candidate. */
export function buildOngoingSessionsFromPlan(
  plan: GroupBookingPlan,
  anchorStartTime: string,
  groupIndex: number,
  confirmedPlayerIds: string[],
  playSlotsDefaults: PlaySlotsDefaults,
  playerPlaySlots: PlayerPlaySlotsMap,
): OngoingSession[] {
  if (plan.proposedBookings.length === 0) return [];

  const byCourt = new Map<number, GroupBookingPlan["proposedBookings"]>();
  for (const b of plan.proposedBookings) {
    const arr = byCourt.get(b.court) ?? [];
    arr.push(b);
    byCourt.set(b.court, arr);
  }

  const confirmedSet = new Set(confirmedPlayerIds);
  const sessions: OngoingSession[] = [];
  for (const [court, bookings] of byCourt) {
    const sorted = [...bookings].sort(
      (a, b) => (parseTeamrTime(a.slotTime) ?? 0) - (parseTeamrTime(b.slotTime) ?? 0),
    );
    // Seuls les joueurs réellement réservés sur CE court (pas tout le groupe, qui peut couvrir
    // plusieurs courts en //) — sinon un late joiner apparaît déjà "présent" sur chaque court à
    // la fois (régression 2026-08-23 : 7 joueurs / 3 courts, le 7e disparaissait du plan).
    const bookedIds = sorted.flatMap((b) => [b.userId, b.partnerId]).filter((id): id is string => id != null);
    const members = [...new Set(bookedIds.filter((id) => confirmedSet.has(id)))];
    sessions.push({
      court,
      anchorStartTime,
      members,
      roundsBooked: sorted.length,
      roundsNeeded: computeRoundsNeededForMembers(members, playSlotsDefaults, playerPlaySlots),
      proposedBookings: sorted,
      groupIndex,
    });
  }
  return sessions;
}

function teamrCountForPlayer(bookings: GroupBookingPlan["proposedBookings"], playerId: string): number {
  let n = 0;
  for (const b of bookings) {
    if (b.userId === playerId || b.partnerId === playerId) n += 1;
  }
  return n;
}

/** Membres n'ayant pas encore atteint leur `minSlots` individuel, ordre de `members` préservé. */
function membersBelowTarget(
  members: string[],
  bookings: GroupBookingPlan["proposedBookings"],
  playSlotsDefaults: PlaySlotsDefaults,
  playerPlaySlots: PlayerPlaySlotsMap,
): string[] {
  return members.filter(
    (id) =>
      teamrCountForPlayer(bookings, id) <
      resolvePlayerPlaySlots(id, playSlotsDefaults, playerPlaySlots).minSlots,
  );
}

function findSlotOnCourt(
  availableSlots: AvailableSlot[],
  usedSessionIds: ReadonlySet<string>,
  court: number,
  beginTime: string,
): AvailableSlot | null {
  for (const s of availableSlots) {
    if (s.court !== court || s.beginTime !== beginTime) continue;
    if (usedSessionIds.has(s.sessionId)) continue;
    return s;
  }
  return null;
}

function nextSlotBeginTime(afterEndTime: string): string | null {
  const endMin = parseTeamrTime(afterEndTime);
  if (endMin == null) return null;
  return formatTeamrTimeFromMinutes(endMin);
}

export interface ExtendSessionOptions {
  session: OngoingSession;
  lateJoinerIds: string[];
  joinTime: string;
  targetDate: string;
  groupId: string;
  maxPlayersPerCourt: number;
  /** Plafond TeamR groupe (rule.maxDailyReservationsPerPlayer) — pas le quota effectif joueur. */
  maxDailyReservationsPerPlayer: number;
  availabilityWindowHours: number;
  availableSlots: AvailableSlot[];
  usedSessionIds: Set<string>;
  /** Prête-noms encore disponibles (volontaires + substituteBookers), mutés à la consommation. */
  substituteQueue: string[];
  /** Joueurs non réinscrits (resa-squash ADR-011) — leur ligne TeamR passe au joker. */
  unregisteredPlayerIds?: ReadonlySet<string>;
  /** Joker de la règle — toujours en partenaire, sans plafond de résas/jour (ADR-024). */
  jokerBookerId?: string | null;
  existingDailyCounts: Readonly<Record<string, number>>;
  playSlotsDefaults: PlaySlotsDefaults;
  playerPlaySlots: PlayerPlaySlotsMap;
  warnings: string[];
}

/**
 * Ajoute des late joiners à une session en cours et prolonge jusqu'à ce que chaque membre du
 * groupe élargi ait atteint son `minSlots` individuel (`resolvePlayerPlaySlots`). Nommage par
 * round adaptatif : les 2 membres ayant le compte de rounds nommés le plus bas sont nommés
 * (ties départagés par l'ordre de `members`) — pas de cycle fixe, car les rounds déjà réservés
 * avant la fusion (late joiner) n'ont jamais suivi de cycle round-robin (2 joueurs y étaient
 * toujours nommés tous les deux). Ne dépasse jamais maxDailyReservationsPerPlayer sur une ligne
 * TeamR : au-delà, bascule sur prête-nom (réutilisable tant qu'il reste sous son propre plafond).
 */
export function extendSessionForLateJoiners(opts: ExtendSessionOptions): GroupBookingPlan["proposedBookings"] {
  const {
    session,
    lateJoinerIds,
    joinTime,
    targetDate,
    groupId,
    maxPlayersPerCourt,
    maxDailyReservationsPerPlayer,
    availabilityWindowHours,
    availableSlots,
    usedSessionIds,
    substituteQueue,
    unregisteredPlayerIds,
    jokerBookerId,
    existingDailyCounts,
    playSlotsDefaults,
    playerPlaySlots,
    warnings,
  } = opts;

  const rawMembers = [...session.members];
  for (const id of lateJoinerIds) {
    if (rawMembers.includes(id)) continue;
    if (rawMembers.length >= maxPlayersPerCourt) {
      warnings.push(`Court ${session.court} : impossible d'ajouter ${id} (plafond ${maxPlayersPerCourt} joueurs/court).`);
      continue;
    }
    rawMembers.push(id);
  }
  const members = orderMembersByDemand(rawMembers, playSlotsDefaults, playerPlaySlots);
  session.members = members;
  const roundsNeeded = computeRoundsNeededForMembers(members, playSlotsDefaults, playerPlaySlots);
  session.roundsNeeded = roundsNeeded;

  if (members.length > 2) {
    warnings.push(
      `Court ${session.court} : rotation à ${members.length} (${members.join(", ")}) — ${roundsNeeded} round(s) au total (les joueurs s'arrangent entre eux pour tourner).`,
    );
  }

  const added: GroupBookingPlan["proposedBookings"] = [];
  const allBookings = () => [...session.proposedBookings, ...added];
  let lastEnd = lastSlotEndTime(allBookings(), session.court) ?? joinTime;

  while (membersBelowTarget(members, allBookings(), playSlotsDefaults, playerPlaySlots).length > 0) {
    if (members.length < 2) {
      // `members` ne contient que les joueurs confirmés réellement réservés sur ce court
      // (buildOngoingSessionsFromPlan filtre sur confirmedSet) — si tous les rounds précédents
      // ont été joués sous prête-nom, il peut y en avoir 0 ou 1 avant la fusion d'un seul late
      // joiner. Sans ce garde, la sélection adaptative plus bas indexerait `sortedByCount[1]`
      // sur un tableau d'1 élément → partnerId undefined → réservation TeamR invalide envoyée
      // telle quelle vers reserve_slot (finding 3, revue finale 2026-08-23).
      warnings.push(
        `Court ${session.court} : impossible d'ajouter un joueur en rotation — pas assez de joueurs confirmés sur ce court pour former une paire TeamR.`,
      );
      break;
    }
    const nextBegin = nextSlotBeginTime(lastEnd);
    if (!nextBegin) break;
    if (!withinAvailabilityWindow(session.anchorStartTime, nextBegin, availabilityWindowHours)) {
      warnings.push(
        `Court ${session.court} : prolongation arrêtée à ${nextBegin} (hors fenêtre ${availabilityWindowHours}h depuis ${session.anchorStartTime}).`,
      );
      break;
    }

    const currentBookings = allBookings();
    const sortedByCount = [...members].sort(
      (a, b) => teamrCountForPlayer(currentBookings, a) - teamrCountForPlayer(currentBookings, b),
    );
    let userId = sortedByCount[0]!;
    let partnerId = sortedByCount[1]!;

    // Joueur non réinscrit sur une prolongation : même règle que le plan principal (ADR-024).
    const unregistered = unregisteredPlayerIds ?? new Set<string>();
    if ([userId, partnerId].some((id) => unregistered.has(id))) {
      const withJoker = resolveBookablePair({
        userId,
        partnerId,
        blockedIds: unregistered,
        substituteQueue,
        jokerBookerId: jokerBookerId ?? null,
      });
      if (!withJoker) continue;
      userId = withJoker.userId;
      partnerId = withJoker.partnerId;
      for (const r of withJoker.replacements) {
        warnings.push(formatPairReplacement(r, "pas réinscrit pour la saison", nextBegin));
      }
    }

    let blocked = false;
    /** Rôles restés au plafond après épuisement des prête-noms — repli joker après la boucle. */
    const quotaBlockedRoles: Array<"userId" | "partnerId"> = [];
    const substitutesUsedThisRound = new Set<string>();
    for (const role of ["userId", "partnerId"] as const) {
      const candidateId = role === "userId" ? userId : partnerId;
      if (jokerBookerId && candidateId === jokerBookerId) continue;
      const already = (existingDailyCounts[candidateId] ?? 0) + teamrCountForPlayer(allBookings(), candidateId);
      if (already < maxDailyReservationsPerPlayer) continue;

      const subIndex = substituteQueue.findIndex((sub) => {
        if (substitutesUsedThisRound.has(sub)) return false;
        const projected = (existingDailyCounts[sub] ?? 0) + teamrCountForPlayer(allBookings(), sub) + 1;
        return projected <= maxDailyReservationsPerPlayer;
      });
      if (subIndex >= 0) {
        const sub = substituteQueue[subIndex]!;
        const projected = (existingDailyCounts[sub] ?? 0) + teamrCountForPlayer(allBookings(), sub) + 1;
        if (projected >= maxDailyReservationsPerPlayer) {
          substituteQueue.splice(subIndex, 1);
        }
        substitutesUsedThisRound.add(sub);
        if (role === "userId") userId = sub;
        else partnerId = sub;
        const substituteNotice = `Court ${session.court} : prolongation TeamR avec prête-nom ${sub} (${candidateId} au plafond ${maxDailyReservationsPerPlayer} résas/jour).`;
        // Dédup : la même paire court/prête-nom peut recevoir le même avertissement à plusieurs
        // rounds de prolongation successifs — comportement pré-refactor restauré (finding 4, revue
        // finale 2026-08-23), sinon la ligne apparaît en double dans les warnings et le fixture JSON.
        if (!warnings.includes(substituteNotice)) {
          warnings.push(substituteNotice);
        }
      } else {
        quotaBlockedRoles.push(role);
      }
    }

    // Plus de prête-nom disponible : le joker prend le relais, en partenaire uniquement et sans
    // limite de nombre (règle métier 2026-09-01). Il ne prive donc jamais le plan d'un prête-nom,
    // mais évite d'abandonner une prolongation faute de nom disponible.
    if (quotaBlockedRoles.length > 0) {
      const stillBlocked = new Set(quotaBlockedRoles.map((role) => (role === "userId" ? userId : partnerId)));
      const resolved = resolveBookablePair({
        userId,
        partnerId,
        blockedIds: stillBlocked,
        substituteQueue: [],
        jokerBookerId: jokerBookerId ?? null,
      });
      if (resolved) {
        userId = resolved.userId;
        partnerId = resolved.partnerId;
        for (const r of resolved.replacements) {
          const notice = `Court ${session.court} : prolongation TeamR au nom du joker ${r.by} (${r.replaced} au plafond ${maxDailyReservationsPerPlayer} résas/jour, aucun prête-nom disponible).`;
          if (!warnings.includes(notice)) warnings.push(notice);
        }
      } else {
        warnings.push(
          `Court ${session.court} : impossible de prolonger — ${[...stillBlocked].join(", ")} au plafond ${maxDailyReservationsPerPlayer} résas/jour, aucun prête-nom disponible${jokerBookerId ? " et joker déjà mobilisé sur cette ligne" : " et aucun joker configuré sur la règle"}.`,
        );
        blocked = true;
      }
    }
    if (blocked) break;

    const slot = findSlotOnCourt(availableSlots, usedSessionIds, session.court, nextBegin);
    if (!slot) {
      warnings.push(`Court ${session.court} : pas de créneau libre à ${nextBegin} pour prolonger la rotation.`);
      break;
    }

    const startDate = slotStartDateIsoHeuristicParis(targetDate, slot.beginTime);
    if (!startDate) break;

    added.push({
      sessionId: slot.sessionId,
      userId,
      partnerId,
      startDate,
      court: session.court,
      slotTime: slot.beginTime,
      slotEndTime: slot.endTime,
      groupId,
    });
    usedSessionIds.add(slot.sessionId);
    lastEnd = slot.endTime;
  }

  const stillShort = membersBelowTarget(members, allBookings(), playSlotsDefaults, playerPlaySlots);
  if (stillShort.length > 0) {
    const shortfallWarning = `Court ${session.court} : min effectif non atteint pour ${stillShort.join(", ")}.`;
    if (!warnings.includes(shortfallWarning)) {
      warnings.push(shortfallWarning);
    }
  }

  session.proposedBookings.push(...added);
  return added;
}

/** Cherche une session fusionnable pour des joueurs orphelins à une heure candidate tardive. */
export function findMergeableSession(
  sessions: OngoingSession[],
  orphanJoinTime: string,
  orphanCount: number,
  maxPlayersPerCourt: number,
  availabilityWindowHours: number,
): OngoingSession | null {
  for (const session of sessions) {
    if (!withinAvailabilityWindow(session.anchorStartTime, orphanJoinTime, availabilityWindowHours)) continue;
    if (!sessionCoversJoinTime(session, orphanJoinTime)) continue;
    if (session.members.length + orphanCount > maxPlayersPerCourt) continue;
    return session;
  }
  return null;
}

/** Fusionne des réservations dans le plan d'un groupe et met à jour meta.rotatingPlayerIds. */
export function appendBookingsToGroupPlan(
  plan: GroupBookingPlan,
  extra: GroupBookingPlan["proposedBookings"],
  rotatingPlayerIds: string[],
): void {
  plan.proposedBookings.push(...extra);
  plan.meta.rotatingPlayerIds = rotatingPlayerIds;
  plan.meta.roundsPlanned += extra.length;
}
