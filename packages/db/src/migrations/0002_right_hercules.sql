CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_rule_id" text NOT NULL,
	"target_date" text NOT NULL,
	"poll_request_id" text,
	"poll_msg_id" text,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "job_run_id" uuid;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_booking_rule_id_booking_rules_id_fk" FOREIGN KEY ("booking_rule_id") REFERENCES "public"."booking_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_job_run_id_job_runs_id_fk" FOREIGN KEY ("job_run_id") REFERENCES "public"."job_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_rules" DROP COLUMN "run_token";