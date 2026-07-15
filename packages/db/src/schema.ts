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
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdateFn(() => new Date()),
});

// ─── Job Runs ────────────────────────────────────────────────────────────────
// Un job = une exécution du pipeline (sondage → collecte/plan → confirmation)
// pour une date cible donnée. Une règle peut avoir plusieurs jobs en parallèle
// (tests manuels multiples, ou un job cron + des jobs manuels côte à côte) —
// thread_id LangGraph = `${bookingRuleId}:${jobRun.id}` (cf.
// apps/worker/src/scheduler/scheduler.ts). pollRequestId/pollMsgId sont
// dénormalisés ici dès l'envoi du sondage pour permettre de consulter le
// tally des votes ou d'annuler le sondage (delete_message) sans repasser par
// LangGraph/Redis.
export const jobRuns = pgTable("job_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingRuleId: text("booking_rule_id")
    .notNull()
    .references(() => bookingRules.id, { onDelete: "cascade" }),
  targetDate: text("target_date").notNull(),
  // Copié depuis bookingRule.sessionStartTime à la création du job — modifiable
  // par job tant qu'il n'a pas démarré (mode manuel), sans toucher la règle.
  // Nullable pour les jobs créés avant l'ajout de cette colonne (repli sur
  // bookingRule.sessionStartTime côté lecture).
  sessionStartTime: text("session_start_time"),
  pollRequestId: text("poll_request_id"),
  pollMsgId: text("poll_msg_id"),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type JobRun = typeof jobRuns.$inferSelect;

// ─── Events ──────────────────────────────────────────────────────────────────
// Log applicatif consultable par règle/job : un événement par étape du pipeline
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
  // Nullable : les événements créés avant l'introduction du modèle "jobs" n'ont pas de job associé.
  jobRunId: uuid("job_run_id").references(() => jobRuns.id, { onDelete: "cascade" }),
  type: text("type", { enum: eventTypeValues }).notNull(),
  status: text("status", { enum: eventStatusValues }).notNull(),
  targetDate: text("target_date").notNull(),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const bookingRulesRelations = relations(bookingRules, ({ many }) => ({
  events: many(events),
  jobRuns: many(jobRuns),
}));

export const jobRunsRelations = relations(jobRuns, ({ one, many }) => ({
  bookingRule: one(bookingRules, { fields: [jobRuns.bookingRuleId], references: [bookingRules.id] }),
  events: many(events),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  bookingRule: one(bookingRules, { fields: [events.bookingRuleId], references: [bookingRules.id] }),
  jobRun: one(jobRuns, { fields: [events.jobRunId], references: [jobRuns.id] }),
}));
