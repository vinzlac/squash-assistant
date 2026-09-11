-- ADR-030 (suite) : défauts globaux de planification, éditables dans /settings, utilisés pour
-- pré-remplir une NOUVELLE règle (N, heure du sondage, M, heure de la décision). Les règles
-- existantes portent leurs propres valeurs et ne sont pas concernées.
ALTER TABLE "app_settings" ADD COLUMN "default_poll_days_before" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "default_poll_time" text DEFAULT '10:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "default_decision_days_before" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "default_decision_time" text DEFAULT '21:30' NOT NULL;
