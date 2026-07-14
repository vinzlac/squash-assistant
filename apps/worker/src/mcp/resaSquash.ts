import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callTool, connectMcpClient, type McpConnection } from "./client.js";

export interface ServerInfo {
  version: string;
  environment: string;
  time: { utcIso: string; displayIso: string; displayCalendarYmd: string };
}

export interface AvailabilitySlot {
  court: number;
  beginTime: string;
  endTime: string;
}

export interface Favorite {
  userId: string;
  firstName: string;
  lastName: string;
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
    beginTime: string;
    endTime: string;
    players: [string, string];
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
): Promise<{ availability: AvailabilitySlot[] }> {
  return callTool(client, "list_availability", { dateFrom, dateTo, courts });
}

export function listMyFavorites(client: Client): Promise<{ favorites: Favorite[] }> {
  return callTool(client, "list_my_favorites");
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
): Promise<{ reservations: Reservation[] }> {
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

export function planGroupSession(
  client: Client,
  players: string[],
  maxSlotsPerDayPerPlayer?: number,
): Promise<GroupBookingPlan> {
  return callTool(client, "plan_group_session", { players, maxSlotsPerDayPerPlayer });
}

export interface PlanGroupBookingsParams {
  groupId: string;
  onDate: string;
  expectedPlayerIds: string[];
  substitutePlayerIds?: string[];
  slotsPerPlayer?: number;
  dryRun?: boolean;
  timeZone?: string;
}

export function planGroupBookings(
  client: Client,
  params: PlanGroupBookingsParams,
): Promise<GroupBookingPlan> {
  return callTool(client, "plan_group_bookings", { dryRun: true, ...params });
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
