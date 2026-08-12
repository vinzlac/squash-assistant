ALTER TABLE "booking_rules" ADD COLUMN "next_day_reminder_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "next_day_reminder_sent_at" timestamp;
