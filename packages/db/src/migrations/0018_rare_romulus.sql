CREATE TABLE "listener_relay_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"poll_creation" boolean DEFAULT true NOT NULL,
	"poll_vote_creation" boolean DEFAULT true NOT NULL,
	"poll_vote_update" boolean DEFAULT true NOT NULL,
	"poll_vote_deletion" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_resa_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"chat_jid" text NOT NULL,
	"chat_name" text,
	"actor_phone" text,
	"actor_name" text,
	"actor_jid" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_resa_events_event_id_unique" UNIQUE("event_id")
);
