import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ─── Booking Rules ───────────────────────────────────────────────────────────
// Une règle associe un groupe WhatsApp à un groupe resa-squash pour un créneau
// récurrent. Un même whatsappGroupJid peut avoir plusieurs règles (ex.
// squashacadémie mardi + squashacadémie jeudi) — géré dynamiquement via l'UI
// (activation par groupe WhatsApp découvert via list_groups, apps/ui).
//
// maxReservationsPerPlayer (→ slotsPerPlayer), priorityBookers (→ ordre de
// expectedPlayerIds), maxCourtsPerSlot (→ maxCourts), preferMinPlayersPerCourt
// et courtPriority ont désormais un équivalent direct côté plan_group_bookings
// (MCP resa-squash — voir ADR-013). minPlayersPerCourt/maxPlayersPerCourt
// restent des seuils locaux à squash-assistant (déclenchent "pas assez de
// joueurs" avant même d'appeler resa-squash, cf. bookSlots.ts).
//
// candidateStartTimes (ex. ["18H45", "19H30"]) remplace l'ancienne heure de
// session unique — chaque heure devient une option du sondage WhatsApp
// (voir ADR-013), et plan_group_bookings est appelé une fois par heure ayant
// des joueurs confirmés (startTime ciblé, cf. bookSlots.ts).
export interface BookingRule {
  id: string;
  /** Nom lisible affiché dans l'UI (l'id reste le slug technique/URL, immuable) — null tant que non renseigné, repli sur id à l'affichage. */
  name: string | null;
  enabled: boolean;
  whatsappGroupJid: string;
  resaSquashGroupId: string;
  pollCron: string;
  decisionCron: string;
  targetWeekdayOffset: number;
  candidateStartTimes: string[];
  maxCourtsPerSlot: number;
  minPlayersPerCourt: number;
  maxPlayersPerCourt: number;
  maxReservationsPerPlayer: number;
  priorityBookers: string[];
  preferMinPlayersPerCourt: boolean;
  courtPriority: number[];
  /** Fenêtre (heures) au-delà de la 1ère heure candidate acceptée pour étaler des joueurs si les courts manquent — voir ADR-014. */
  availabilityWindowHours: number;
  /** Description en français générée par describeRuleInFrench, mise en cache à chaque sauvegarde (évite de re-résoudre les noms de groupe/joueurs à chaque affichage) — null tant qu'aucune sauvegarde n'a eu lieu depuis l'ajout de cette colonne. */
  description: string | null;
  /** userIds resa-squash, par ordre de priorité, utilisables comme prête-nom si un joueur attendu (souvent le titulaire de la clé API) est à quota — voir ADR-016. */
  substituteBookers: string[];
  /** Plafond « maison » de résas/jour transmis à plan_group_bookings (pas une limite TeamR) — peut différer par groupe, voir ADR-016. */
  maxDailyReservationsPerPlayer: number;
  /**
   * Joker de réservation : userId resa-squash d'un joueur sans plafond et toujours réinscrit
   * (le gérant du club) — utilisé pour remplacer un joueur que TeamR refuse au moment du
   * `reserve_slot` (non réinscrit, ou quota atteint). Voir ADR-024.
   * `null` = pas de joker (l'échec reste un échec, comportement historique).
   * Distinct de `substituteBookers` : le joker n'est pas consommé du tout — il se met en
   * **partenaire** autant de fois qu'il le faut, y compris plusieurs fois au même horaire,
   * tant que le **titulaire** de la réservation est bien inscrit.
   */
  jokerBookerId: string | null;
  /** Nombre de joueurs imprévus à provisionner en plus des confirmés (ex. le samedi il vient souvent 1 joueur de plus non inscrit) — traités exactement comme des confirmés (mêmes créneaux), sourcés depuis substituteBookers. Défaut 0 (pas de marge). */
  unexpectedPlayersMargin: number;
  /**
   * Groupe WhatsApp destinataire de l'annonce de réservation (étape Announce).
   * `null` = même groupe que le sondage (`whatsappGroupJid`) ;
   * sinon JID d'un autre groupe (ex. groupe de test « Vincent All »).
   */
  reservationNotifyWhatsappGroupJid: string | null;
  /**
   * Fenêtre de flou (minutes) après `pollCron` / `decisionCron` : l'action auto
   * part après un délai aléatoire uniforme dans [0, N min). Défaut 60. 0 = immédiat.
   */
  cronJitterWindowMinutes: number;
  /**
   * Jobs auto (`JobRun.auto`) : attendre un message Telegram "go" avant l'étape Announce.
   * `false` = enchaîner directement en réservation réelle après le calcul du plan.
   */
  requireTelegramGoForAutoJobs: boolean;
  /**
   * Envoie un rappel WhatsApp (reprise du message d'annonce) le lendemain de
   * `targetDate`, vers 0h05-0h15 (Europe/Paris) — voir regles-fonctionnelles.md.
   * Défaut false : n'affecte aucune règle existante sans validation explicite.
   */
  nextDayReminderEnabled: boolean;
}

export const bookingRules = pgTable("booking_rules", {
  id: text("id").primaryKey(),
  name: text("name"),
  enabled: boolean("enabled").notNull().default(false),
  whatsappGroupJid: text("whatsapp_group_jid").notNull(),
  resaSquashGroupId: text("resa_squash_group_id").notNull(),
  pollCron: text("poll_cron").notNull(),
  decisionCron: text("decision_cron").notNull(),
  targetWeekdayOffset: integer("target_weekday_offset").notNull(),
  candidateStartTimes: jsonb("candidate_start_times").notNull().default(["18H45"]).$type<string[]>(),
  maxCourtsPerSlot: integer("max_courts_per_slot").notNull().default(3),
  minPlayersPerCourt: integer("min_players_per_court").notNull().default(2),
  maxPlayersPerCourt: integer("max_players_per_court").notNull().default(3),
  maxReservationsPerPlayer: integer("max_reservations_per_player").notNull().default(2),
  priorityBookers: jsonb("priority_bookers").notNull().default([]).$type<string[]>(),
  preferMinPlayersPerCourt: boolean("prefer_min_players_per_court").notNull().default(true),
  courtPriority: jsonb("court_priority").notNull().default([]).$type<number[]>(),
  availabilityWindowHours: integer("availability_window_hours").notNull().default(3),
  description: text("description"),
  substituteBookers: jsonb("substitute_bookers").notNull().default([]).$type<string[]>(),
  maxDailyReservationsPerPlayer: integer("max_daily_reservations_per_player").notNull().default(2),
  jokerBookerId: text("joker_booker_id"),
  unexpectedPlayersMargin: integer("unexpected_players_margin").notNull().default(0),
  reservationNotifyWhatsappGroupJid: text("reservation_notify_whatsapp_group_jid"),
  cronJitterWindowMinutes: integer("cron_jitter_window_minutes").notNull().default(60),
  requireTelegramGoForAutoJobs: boolean("require_telegram_go_for_auto_jobs").notNull().default(true),
  nextDayReminderEnabled: boolean("next_day_reminder_enabled").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdateFn(() => new Date()),
});

// ─── Scenarios (simulateur de réservation) ──────────────────────────────────
// Un scénario associe un jeu de joueurs (avec leur vote) à UNE règle donnée,
// pour calculer un plan de réservation avec une disponibilité synthétique
// "tout libre" — voir docs/adr/ADR-019 et docs/superpowers/specs/2026-08-01-*.
export interface ScenarioPlayer {
  playerId: string;
  /** Dénormalisé au moment de l'ajout — affichage sans re-résolution. */
  name: string;
  /** Une heure candidate de la règle (ex. "18H45"), "prete-nom", ou "non". Mutuellement exclusif. */
  vote: string;
}

export const scenarios = pgTable("scenarios", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingRuleId: text("booking_rule_id")
    .notNull()
    .references(() => bookingRules.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  players: jsonb("players").notNull().default([]).$type<ScenarioPlayer[]>(),
  /** null = non évalué, true = plan OK (exportable), false = plan pas OK. */
  validated: boolean("validated"),
  /** Dernier plan calculé (BookingPlanGroup[]) — évite un recalcul à l'ouverture du scénario. */
  lastPlan: jsonb("last_plan"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdateFn(() => new Date()),
});

export type Scenario = typeof scenarios.$inferSelect;

export const scenariosRelations = relations(scenarios, ({ one }) => ({
  bookingRule: one(bookingRules, { fields: [scenarios.bookingRuleId], references: [bookingRules.id] }),
}));

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
  // Copié depuis bookingRule.candidateStartTimes à la création du job —
  // modifiable par job tant qu'il n'a pas démarré (mode manuel), sans toucher
  // la règle. Nullable pour les jobs créés avant l'ajout de cette colonne
  // (repli sur bookingRule.candidateStartTimes côté lecture).
  candidateStartTimes: jsonb("candidate_start_times").$type<string[]>(),
  pollRequestId: text("poll_request_id"),
  pollMsgId: text("poll_msg_id"),
  // Copie figée de la BookingRule au moment de la création du job — traçabilité
  // si la règle est éditée après coup (ADR-014). Nullable pour les jobs créés
  // avant l'ajout de cette colonne.
  ruleSnapshot: jsonb("rule_snapshot").$type<BookingRule>(),
  cancelledAt: timestamp("cancelled_at"),
  /** true si créé par le scheduler (cron pollCron), false si créé manuellement depuis l'UI. Défaut false pour les jobs existants (créés avant cette colonne, tous manuels à l'époque). */
  auto: boolean("auto").notNull().default(false),
  /** Horodatage d'envoi du rappel J+1 (étape optionnelle) — null tant que non envoyé. Garde-fou anti-doublon (redémarrage du pod, plusieurs ticks du cron). */
  nextDayReminderSentAt: timestamp("next_day_reminder_sent_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type JobRun = typeof jobRuns.$inferSelect;

// ─── Events ──────────────────────────────────────────────────────────────────
// Log applicatif consultable par règle/job : un événement par étape du pipeline
// (poll, collecte des votes, réservation/annonce), avec le détail et le statut.

export const eventTypeValues = ["poll", "collect_votes", "booking", "club-closed"] as const;
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
  scenarios: many(scenarios),
}));

export const jobRunsRelations = relations(jobRuns, ({ one, many }) => ({
  bookingRule: one(bookingRules, { fields: [jobRuns.bookingRuleId], references: [bookingRules.id] }),
  events: many(events),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  bookingRule: one(bookingRules, { fields: [events.bookingRuleId], references: [bookingRules.id] }),
  jobRun: one(jobRuns, { fields: [events.jobRunId], references: [jobRuns.id] }),
}));

// ─── App Settings ────────────────────────────────────────────────────────────
// Ligne unique (id="singleton") — préférences d'affichage de l'UI, indépendantes
// des BookingRule. visibleWhatsappGroupJids: null = jamais configuré (affiche
// tous les groupes WhatsApp remontés par huddle-bot, comportement historique) ;
// tableau (même vide) = sélection explicite depuis /settings.
// defaultMin/MaxPlaySlots : quotas de temps de jeu effectif (créneaux de 45 min)
// appliqués à tous les joueurs sauf surcharge dans player_preferences.
export const appSettings = pgTable("app_settings", {
  id: text("id").primaryKey().default("singleton"),
  visibleWhatsappGroupJids: jsonb("visible_whatsapp_group_jids").$type<string[] | null>(),
  defaultMinPlaySlots: integer("default_min_play_slots").notNull().default(2),
  defaultMaxPlaySlots: integer("default_max_play_slots").notNull().default(2),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdateFn(() => new Date()),
});

export type AppSettings = typeof appSettings.$inferSelect;

// ─── Club closures ─────────────────────────────────────────────────────────────
export const clubClosures = pgTable("club_closures", {
  id: uuid("id").primaryKey().defaultRandom(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ClubClosure = typeof clubClosures.$inferSelect;

// ─── Player preferences ──────────────────────────────────────────────────────
// Surcharges par userId resa-squash du temps de jeu effectif min/max (en créneaux
// de 45 min). Absent = défauts app_settings. Ne remplace pas le plafond TeamR
// de la BookingRule (maxDailyReservationsPerPlayer).
export const playerPreferences = pgTable("player_preferences", {
  userId: text("user_id").primaryKey(),
  displayName: text("display_name"),
  minPlaySlots: integer("min_play_slots").notNull(),
  maxPlaySlots: integer("max_play_slots").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdateFn(() => new Date()),
});

export type PlayerPreference = typeof playerPreferences.$inferSelect;

export const whatsappResaEvents = pgTable("whatsapp_resa_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: text("event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  chatJid: text("chat_jid").notNull(),
  chatName: text("chat_name"),
  actorPhone: text("actor_phone"),
  actorName: text("actor_name"),
  actorJid: text("actor_jid").notNull(),
  summary: text("summary").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const listenerRelaySettings = pgTable("listener_relay_settings", {
  id: text("id").primaryKey().default("default"),
  pollCreation: boolean("poll_creation").notNull().default(true),
  pollVoteCreation: boolean("poll_vote_creation").notNull().default(true),
  pollVoteUpdate: boolean("poll_vote_update").notNull().default(true),
  pollVoteDeletion: boolean("poll_vote_deletion").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdateFn(() => new Date()),
});
