import { and, asc, count, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { bookingRules, listenerRelaySettings, whatsappResaEvents } from "@squash-assistant/db/schema";
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
  /** WhatsApp group JID (exact match). */
  groupJid?: string;
  /** Phone E.164-ish or display name — matched against actor_phone / actor_name. */
  actor?: string;
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

export interface ListenerActorOption {
  /** Stable select value — prefer phone, else name. */
  value: string;
  label: string;
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

function buildWhere(filter: ListResaEventsFilter): SQL | undefined {
  const parts: SQL[] = [];

  if (filter.eventType) {
    parts.push(eq(whatsappResaEvents.eventType, filter.eventType));
  }
  if (filter.groupJid?.trim()) {
    parts.push(eq(whatsappResaEvents.chatJid, filter.groupJid.trim()));
  }
  if (filter.actor?.trim()) {
    const raw = filter.actor.trim();
    const phone = normalizePhone(raw);
    // Phone-like value → exact-ish match on actor_phone (digits); otherwise name contains.
    if (phone.length >= 8 && /^[\d+]+$/.test(phone.replace(/^\+/, ""))) {
      parts.push(
        or(
          eq(whatsappResaEvents.actorPhone, raw),
          eq(whatsappResaEvents.actorPhone, phone),
          ilike(whatsappResaEvents.actorPhone, `%${phone.replace(/^\+/, "")}%`),
        )!,
      );
    } else {
      parts.push(ilike(whatsappResaEvents.actorName, `%${raw}%`));
    }
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

/** Distinct actors already seen in the listener history (fallback / complement to resa-squash). */
export async function listDistinctEventActors(): Promise<ListenerActorOption[]> {
  const rows = await getDb()
    .select({
      actorName: whatsappResaEvents.actorName,
      actorPhone: whatsappResaEvents.actorPhone,
    })
    .from(whatsappResaEvents)
    .groupBy(whatsappResaEvents.actorName, whatsappResaEvents.actorPhone);

  const byValue = new Map<string, ListenerActorOption>();
  for (const row of rows) {
    const phone = row.actorPhone?.trim() || null;
    const name = row.actorName?.trim() || null;
    if (!phone && !name) continue;
    const value = phone ?? name!;
    const label = phone && name ? `${name} (${phone})` : (name ?? phone!);
    if (!byValue.has(value)) byValue.set(value, { value, label });
  }
  return [...byValue.values()].sort((a, b) => a.label.localeCompare(b.label, "fr"));
}

/** Unique resa-squash groupIds linked from booking rules (all groups we manage). */
export async function listBookingRuleResaGroupIds(): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ groupId: bookingRules.resaSquashGroupId })
    .from(bookingRules)
    .where(sql`${bookingRules.resaSquashGroupId} <> ''`);
  return rows.map((r) => r.groupId).filter(Boolean);
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
