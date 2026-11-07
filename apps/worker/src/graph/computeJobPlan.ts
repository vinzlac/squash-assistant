import { listAvailability, listMyReservationsOnDate, type AvailabilitySlot } from "../mcp/resaSquash.js";
import { loadPlaySlotsConfig } from "../planning/loadPlayerPlaySlots.js";
import { planJobBookings } from "../planning/planJob.js";
import type { AvailableSlot } from "../planning/courtAssignment.js";
import type { BookingRule } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "./dependencies.js";
import type { BookingPlanGroup } from "./state.js";
import { fetchGroupMemberDirectory, resolveLiveJokerBookerId } from "./nodes/announce.js";

function toAvailableSlot(slot: AvailabilitySlot): AvailableSlot {
  return { sessionId: slot.id, court: slot.court, beginTime: slot.time, endTime: slot.endTime };
}

/**
 * Calcule le plan d'un job à partir de l'état courant du club : disponibilités, préférences de
 * temps de jeu, joueurs non réinscrits et joker live. Partagé entre l'étape 3 (bookSlots) et le
 * recalcul après refus d'un prête-nom ou du joker à la réservation (ADR-039 point 6), où
 * `excludedBookerIds` écarte les noms refusés par TeamR et `ownSlots` rend au plan les courts que
 * le job tient déjà.
 */
export async function computeJobPlan(
  deps: GraphDependencies,
  bookingRule: BookingRule,
  targetDate: string,
  confirmedPlayerIdsByTime: Record<string, string[]>,
  volunteerSubstituteIds: string[],
  excludedBookerIds: ReadonlySet<string> = new Set(),
  /** Courts déjà pris par ce job et réutilisables par le recalcul (TeamR les voit occupés). */
  ownSlots: readonly AvailableSlot[] = [],
): Promise<BookingPlanGroup[]> {
  const { availability } = await listAvailability(deps.resaSquash.client, targetDate, targetDate);
  const free = availability.flatMap((day) => day.slots.filter((s) => s.available).map(toAvailableSlot));
  const availableSlots = [...ownSlots.filter((o) => !free.some((f) => f.sessionId === o.sessionId)), ...free];
  const { userId: apiUserId } = await listMyReservationsOnDate(deps.resaSquash.client, targetDate);
  const playSlots = await loadPlaySlotsConfig(deps.db);
  // Statut de réinscription connu dès le plan : un joueur non réinscrit ne porte pas de nom TeamR
  // (ADR-024). Best-effort — si resa-squash est indisponible, la substitution de rattrapage à la
  // réservation reste le filet de sécurité.
  const { unregisteredPlayerIds } = await fetchGroupMemberDirectory(deps.resaSquash, bookingRule.resaSquashGroupId).catch(
    () => ({ unregisteredPlayerIds: new Set<string>() }),
  );
  // Le joker est relu sur la règle live : l'état du graphe fige `bookingRule` au lancement du
  // sondage, et le configurer après coup doit prendre effet sur ce job (ADR-024).
  const ruleForPlan: BookingRule = { ...bookingRule, jokerBookerId: await resolveLiveJokerBookerId(deps, bookingRule) };

  return planJobBookings(
    ruleForPlan,
    targetDate,
    confirmedPlayerIdsByTime,
    volunteerSubstituteIds,
    availableSlots,
    apiUserId,
    { ...playSlots, excludedBookerIds },
    unregisteredPlayerIds,
  );
}
