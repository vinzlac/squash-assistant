ALTER TABLE "booking_rules" ADD COLUMN "start_reminder_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_rules" ADD COLUMN "start_reminder_minutes_before" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "start_reminder_sent_at" timestamp;