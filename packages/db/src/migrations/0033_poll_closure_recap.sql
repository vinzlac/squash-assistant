ALTER TABLE "job_runs" ADD COLUMN "poll_closed_at" timestamp;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "recap_msg_id" text;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "recap_jid" text;