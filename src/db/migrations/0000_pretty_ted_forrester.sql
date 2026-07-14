CREATE TABLE "booking_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"whatsapp_group_jid" text NOT NULL,
	"resa_squash_group_id" text NOT NULL,
	"poll_cron" text NOT NULL,
	"decision_cron" text NOT NULL,
	"target_weekday_offset" integer NOT NULL,
	"session_start_time" text NOT NULL,
	"max_courts_per_slot" integer DEFAULT 3 NOT NULL,
	"min_players_per_court" integer DEFAULT 2 NOT NULL,
	"max_players_per_court" integer DEFAULT 3 NOT NULL,
	"max_reservations_per_player" integer DEFAULT 2 NOT NULL,
	"priority_bookers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prefer_min_players_per_court" boolean DEFAULT true NOT NULL,
	"court_priority" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_rule_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"target_date" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_booking_rule_id_booking_rules_id_fk" FOREIGN KEY ("booking_rule_id") REFERENCES "public"."booking_rules"("id") ON DELETE cascade ON UPDATE no action;