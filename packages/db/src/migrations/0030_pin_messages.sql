ALTER TABLE "booking_rules" ADD COLUMN "pin_messages_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "announce_msg_id" text;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "announce_jid" text;