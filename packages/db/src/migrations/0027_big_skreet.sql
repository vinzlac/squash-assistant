ALTER TABLE "app_settings" ADD COLUMN "default_confirmation_days_before" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "default_confirmation_time" text DEFAULT '22:30' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_rules" ADD COLUMN "confirmation_days_before" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_rules" ADD COLUMN "confirmation_time" text DEFAULT '10:30' NOT NULL;--> statement-breakpoint
-- Même jour que la décision. 10:30 si c'est après l'heure de décision, sinon une heure après.
UPDATE "booking_rules" SET
  "confirmation_days_before" = "decision_days_before",
  "confirmation_time" = CASE
    WHEN "decision_time" < '10:30' THEN '10:30'
    WHEN "decision_time" < '23:00' THEN to_char(("decision_time"::time + interval '1 hour'), 'HH24:MI')
    ELSE '23:30'
  END;--> statement-breakpoint
UPDATE "app_settings" SET
  "default_confirmation_days_before" = "default_decision_days_before",
  "default_confirmation_time" = CASE
    WHEN "default_decision_time" < '10:30' THEN '10:30'
    WHEN "default_decision_time" < '23:00' THEN to_char(("default_decision_time"::time + interval '1 hour'), 'HH24:MI')
    ELSE '23:30'
  END;