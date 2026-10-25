ALTER TABLE "job_runs" ADD COLUMN "roster_photo" jsonb;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "roster_identities" jsonb;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "roster_plan_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "roster_final" jsonb;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "roster_msg_id" text;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "roster_jid" text;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "roster_sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "roster_fingerprint" text;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "roster_pinned_at" timestamp;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "roster_orphan" jsonb;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "roster_claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "roster_stopped_at" timestamp;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "poll_unpinned_at" timestamp;