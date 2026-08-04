import { and, asc, count, desc, eq, gte, ilike, lte, or, type SQL } from "drizzle-orm";
import { listenerRelaySettings, whatsappResaEvents } from "@squash-assistant/db/schema";
import { getDb } from "./db";

const DEFAULT_SETTINGS_ID = "default";

export type RelaySettings = typeof listenerRelaySettings.$inferSelect;

export type RelaySettingsUpdate = Partial<
  Pick<
    RelaySettings,
    "pollCreation" | "pollVoteCreation" | "pollVoteUpdate" | "pollVoteDeletion"
  >
>;

export type ResaEventsSort = "desc" | "asc";

export interface ListResaEventsFilter {
  eventType?: string;
  group?: string;
  actor?: string;
  summary?: string;
  /** Inclusive lower bound on occurredAt (ISO or date string parsed by Date). */
  occurredFrom?: string;
  /** Inclusive upper bound on occurredAt. */
  occurredTo?: string;
}

export interface ListResaEventsParams extends ListResaEventsFilter {
  limit: number;
  offset: number;
  sort?: ResaEventsSort;
}

function buildWhere(filter: ListResaEventsFilter): SQL | undefined {
  const parts: SQL[] = [];

  if (filter.eventType) {
    parts.push(eq(whatsappResaEvents.eventType, filter.eventType));
  }
  if (filter.group?.trim()) {
    const q = `%${filter.group.trim()}%`;
    parts.push(or(ilike(whatsappResaEvents.chatName, q), ilike(whatsappResaEvents.chatJid, q))!);
  }
  if (filter.actor?.trim()) {
    const q = `%${filter.actor.trim()}%`;
    parts.push(
      or(ilike(whatsappResaEvents.actorName, q), ilike(whatsappResaEvents.actorPhone, q))!,
    );
  }
  if (filter.summary?.trim()) {
    parts.push(ilike(whatsappResaEvents.summary, `%${filter.summary.trim()}%`));
  }
  if (filter.occurredFrom) {
    const d = new Date(filter.occurredFrom);
    if (!Number.isNaN(d.getTime())) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(filter.occurredFrom)) d.setHours(0, 0, 0, 0);
      parts.push(gte(whatsappResaEvents.occurredAt, d));
    }
  }
  if (filter.occurredTo) {
    const d = new Date(filter.occurredTo);
    if (!Number.isNaN(d.getTime())) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(filter.occurredTo)) d.setHours(23, 59, 59, 999);
      parts.push(lte(whatsappResaEvents.occurredAt, d));
    }
  }

  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return and(...parts);
}

export async function listResaEvents(params: ListResaEventsParams) {
  const { limit, offset, sort = "desc", ...filter } = params;
  const where = buildWhere(filter);
  const order =
    sort === "asc" ? asc(whatsappResaEvents.occurredAt) : desc(whatsappResaEvents.occurredAt);

  const db = getDb();
  let query = db.select().from(whatsappResaEvents).$dynamic();
  if (where) query = query.where(where);

  return query.orderBy(order).limit(limit).offset(offset);
}

export async function countResaEvents(filter: ListResaEventsFilter = {}): Promise<number> {
  const where = buildWhere(filter);
  const db = getDb();
  let query = db.select({ value: count() }).from(whatsappResaEvents).$dynamic();
  if (where) query = query.where(where);
  const [row] = await query;
  return row?.value ?? 0;
}

export async function getRelaySettings(): Promise<RelaySettings> {
  const db = getDb();
  await db.insert(listenerRelaySettings).values({ id: DEFAULT_SETTINGS_ID }).onConflictDoNothing();

  const [row] = await db
    .select()
    .from(listenerRelaySettings)
    .where(eq(listenerRelaySettings.id, DEFAULT_SETTINGS_ID))
    .limit(1);

  if (!row) {
    throw new Error("listener_relay_settings default row missing");
  }
  return row;
}

export async function updateRelaySettings(partial: RelaySettingsUpdate): Promise<void> {
  await getDb()
    .update(listenerRelaySettings)
    .set({ ...partial, updatedAt: new Date() })
    .where(eq(listenerRelaySettings.id, DEFAULT_SETTINGS_ID));
}
