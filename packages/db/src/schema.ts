import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ─── Booking Rules ───────────────────────────────────────────────────────────
// Une règle associe un groupe WhatsApp à un groupe resa-squash pour un créneau
// récurrent. Un même whatsappGroupJid peut avoir plusieurs règles (ex.
// squashacadémie mardi + squashacadémie jeudi) — géré dynamiquement via l'UI
// (activation par groupe WhatsApp découvert via list_groups, apps/ui).
//
// Seuls maxReservationsPerPlayer (→ slotsPerPlayer) et priorityBookers
// (→ ordre de expectedPlayerIds) ont un équivalent direct côté
// plan_group_bookings (MCP resa-squash, vérifié via listTools() en Phase 1).
// maxCourtsPerSlot, minPlayersPerCourt, maxPlayersPerCourt,
// preferMinPlayersPerCourt et courtPriority sont stockés mais pas encore
// branchés à un appel MCP — aucun paramètre équivalent n'existe aujourd'hui
// côté resa-squash (à revisiter si le tool évolue, ou si squash-assistant
// doit un jour construire sa propre couche d'allocation).
export interface BookingRule {
  id: string;
  enabled: boolean;
  whatsappGroupJid: string;
  resaSquashGroupId: string;
  pollCron: string;
  decisionCron: string;
  targetWeekdayOffset: number;
  sessionStartTime: string;
  maxCourtsPerSlot: number;
  minPlayersPerCourt: number;
  maxPlayersPerCourt: number;
  maxReservationsPerPlayer: number;
  priorityBookers: string[];
  preferMinPlayersPerCourt: boolean;
  courtPriority: number[];
  runToken: number;
}

export const bookingRules = pgTable("booking_rules", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  whatsappGroupJid: text("whatsapp_group_jid").notNull(),
  resaSquashGroupId: text("resa_squash_group_id").notNull(),
  pollCron: text("poll_cron").notNull(),
  decisionCron: text("decision_cron").notNull(),
  targetWeekdayOffset: integer("target_weekday_offset").notNull(),
  sessionStartTime: text("session_start_time").notNull(),
  maxCourtsPerSlot: integer("max_courts_per_slot").notNull().default(3),
  minPlayersPerCourt: integer("min_players_per_court").notNull().default(2),
  maxPlayersPerCourt: integer("max_players_per_court").notNull().default(3),
  maxReservationsPerPlayer: integer("max_reservations_per_player").notNull().default(2),
  priorityBookers: jsonb("priority_bookers").notNull().default([]).$type<string[]>(),
  preferMinPlayersPerCourt: boolean("prefer_min_players_per_court").notNull().default(true),
  courtPriority: jsonb("court_priority").notNull().default([]).$type<number[]>(),
  // Incrémenté par "Nouveau job" (UI) pour repartir sur un thread LangGraph
  // vierge sans attendre la semaine calendaire suivante — cf. threadIdFor
  // dans apps/worker/src/scheduler/scheduler.ts.
  runToken: integer("run_token").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdateFn(() => new Date()),
});

// ─── Events ──────────────────────────────────────────────────────────────────
// Log applicatif consultable par règle : un événement par étape du pipeline
// (poll, collecte des votes, réservation/annonce), avec le détail et le statut.

export const eventTypeValues = ["poll", "collect_votes", "booking"] as const;
export type EventType = (typeof eventTypeValues)[number];

export const eventStatusValues = ["success", "error"] as const;
export type EventStatus = (typeof eventStatusValues)[number];

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingRuleId: text("booking_rule_id")
    .notNull()
    .references(() => bookingRules.id, { onDelete: "cascade" }),
  type: text("type", { enum: eventTypeValues }).notNull(),
  status: text("status", { enum: eventStatusValues }).notNull(),
  targetDate: text("target_date").notNull(),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const bookingRulesRelations = relations(bookingRules, ({ many }) => ({
  events: many(events),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  bookingRule: one(bookingRules, { fields: [events.bookingRuleId], references: [bookingRules.id] }),
}));
