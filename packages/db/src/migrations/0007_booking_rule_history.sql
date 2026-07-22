CREATE TABLE "booking_rule_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_rule_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_rule_history" ADD CONSTRAINT "booking_rule_history_booking_rule_id_booking_rules_id_fk" FOREIGN KEY ("booking_rule_id") REFERENCES "public"."booking_rules"("id") ON DELETE cascade ON UPDATE no action;