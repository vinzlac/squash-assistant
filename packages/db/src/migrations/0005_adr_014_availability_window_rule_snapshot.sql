ALTER TABLE "booking_rules" ADD COLUMN "availability_window_hours" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "rule_snapshot" jsonb;