CREATE TABLE "app_settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"visible_whatsapp_group_jids" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
