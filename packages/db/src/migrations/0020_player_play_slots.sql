ALTER TABLE "app_settings" ADD COLUMN "default_min_play_slots" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "default_max_play_slots" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
CREATE TABLE "player_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"min_play_slots" integer NOT NULL,
	"max_play_slots" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
