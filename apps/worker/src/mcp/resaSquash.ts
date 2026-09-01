import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callTool, connectMcpClient, type McpConnection } from "./client.js";

export interface ServerInfo {
  version: string;
  environment: string;
  time: { utcIso: string; displayIso: string; displayCalendarYmd: string };
}

export interface AvailabilityUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  yes: boolean;
}

/** Reflète le payload réel de list_availability côté resa-squash (app/types/reservation.ts) — pas de transformation de champs. */
export interface AvailabilitySlot {
  id: string;
  court: number;
  time: string;
  endTime: string;
  date: string;
  participants: number;
  available: boolean;
  users: AvailabilityUser[];
}

export interface Favorite {
  userId: string;
  /** null si le licencié n'est pas (ou plus) connu localement côté resa-squash. */
  firstName: string | null;
  lastName: string | null;
  /** false = pas réinscrit pour la saison, donc non réservable (resa-squash ADR-011). */
  isRegistered?: boolean;
  deletedAt?: string | null;
}

export interface GroupSummary {
  groupId: string;
  label: string;
  myRole: string;
  memberCount: number;
  isOwner: boolean;
  recurringWeekday: number | null;
  recurringStartTime: string | null;
  bookingMinSlotsPerPlayer: number;
  bookingMaxSlotsPerPlayer: number;
}

export interface GroupMember {
  group_id: string;
  user_id: string;
  licensee_id: string;
  added_at: string;
  role: string;
  first_name: string;
  last_name: string;
  phone?: string;
}

export interface PlayerLookup {
  found: boolean;
  userId?: string;
  firstName?: string;
  lastName?: string;
}

export interface Reservation {
  sessionId: string;
  userId: string;
  partnerId?: string;
  court: number;
  beginTime: string;
  endTime: string;
  date: string;
  groupId?: string | null;
}

export interface GroupBookingPlan {
  dryRun: boolean;
  proposedBookings: Array<{
    sessionId: string;
    court: number;
    userId: string;
    partnerId?: string;
    groupId?: string | null;
    slotTime: string;
    slotEndTime: string;
    startDate?: string;
  }>;
  warnings: string[];
  meta: {
    courtsNeeded: number;
    roundsPlanned: number;
    dryRun: boolean;
    groupLabel: string;
    recurringWeekday: number;
    recurringStartTime: string;
    slotsPerPlayer: number;
    groupMinSlotsPerPlayer: number;
    groupMaxSlotsPerPlayer: number;
    pairCount: number;
    rotatingPlayerIds?: string[];
  };
}

export function connectResaSquash(url: string, apiKey: string): Promise<McpConnection> {
  return connectMcpClient("resa-squash", url, apiKey);
}

export function serverInfo(client: Client, timeZone?: string): Promise<ServerInfo> {
  return callTool(client, "server_info", { timeZone });
}

export function listAvailability(
  client: Client,
  dateFrom: string,
  dateTo: string,
  courts?: number[],
): Promise<{ dateFrom: string; dateTo: string; availability: Array<{ date: string; slots: AvailabilitySlot[] }> }> {
  return callTool(client, "list_availability", { dateFrom, dateTo, courts });
}

/**
 * Favoris du compte de la clé API. resa-squash masque par défaut les joueurs non réinscrits
 * (non réservables) — `includeUnregistered` pour les voir quand même. Voir resa-squash ADR-011.
 */
export function listMyFavorites(
  client: Client,
  includeUnregistered = false,
): Promise<{ favorites: Favorite[]; unregisteredCount?: number }> {
  return callTool(client, "list_my_favorites", { includeUnregistered });
}

export function listMyGroups(client: Client): Promise<{ groups: GroupSummary[] }> {
  return callTool(client, "list_my_groups");
}

export function listGroupMembers(
  client: Client,
  groupId: string,
  includePhones = false,
): Promise<{ members: GroupMember[] }> {
  return callTool(client, "list_group_members", { groupId, includePhones });
}

export function lookupPlayerByPhone(client: Client, phone: string): Promise<PlayerLookup> {
  return callTool(client, "lookup_player_by_phone", { phone });
}

export function listMyReservations(
  client: Client,
  fromDate?: string,
): Promise<{ reservations: Reservation[] }> {
  return callTool(client, "list_my_reservations", { fromDate });
}

export function listMyReservationsOnDate(
  client: Client,
  onDate: string,
  timeZone = "Europe/Paris",
): Promise<{ userId: string; onDate: string; timeZone: string; reservations: Reservation[] }> {
  return callTool(client, "list_my_reservations_on_date", { onDate, timeZone });
}

export function listReservationsForGroupOnDate(
  client: Client,
  groupId: string,
  onDate: string,
  timeZone = "Europe/Paris",
): Promise<{ reservations: Reservation[] }> {
  return callTool(client, "list_reservations_for_group_on_date", { groupId, onDate, timeZone });
}

export function listAllReservationsOnDate(
  client: Client,
  onDate: string,
  courts?: number[],
): Promise<{ reservations: Reservation[] }> {
  return callTool(client, "list_all_reservations_on_date", { onDate, courts });
}


export interface ReserveSlotParams {
  sessionId: string;
  userId: string;
  partnerId: string;
  startDate: string;
  groupId?: string | null;
}

export function reserveSlot(client: Client, params: ReserveSlotParams): Promise<Reservation> {
  return callTool(client, "reserve_slot", { ...params });
}

export function cancelReservation(
  client: Client,
  params: { sessionId: string; userId: string; partnerId: string },
): Promise<void> {
  return callTool(client, "cancel_reservation", { ...params });
}
