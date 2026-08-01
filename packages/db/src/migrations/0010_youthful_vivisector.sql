CREATE TABLE "scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_rule_id" text NOT NULL,
	"name" text NOT NULL,
	"players" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"api_user_id" text,
	"validated" boolean,
	"last_plan" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_booking_rule_id_booking_rules_id_fk" FOREIGN KEY ("booking_rule_id") REFERENCES "public"."booking_rules"("id") ON DELETE cascade ON UPDATE no action;