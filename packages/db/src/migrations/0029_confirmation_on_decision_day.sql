ALTER TABLE "app_settings" ALTER COLUMN "default_confirmation_days_before" SET DEFAULT 7;--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "default_confirmation_time" SET DEFAULT '22:30';--> statement-breakpoint
ALTER TABLE "booking_rules" ALTER COLUMN "confirmation_days_before" SET DEFAULT 7;--> statement-breakpoint
ALTER TABLE "booking_rules" ALTER COLUMN "confirmation_time" SET DEFAULT '22:30';--> statement-breakpoint
-- Jour de la décision (jour où la réservation est prise). L'heure reste si elle est
-- déjà après la décision ; sinon une heure plus tard, pour respecter l'invariant.
UPDATE "booking_rules" SET
  "confirmation_days_before" = "decision_days_before",
  "confirmation_time" = CASE
    WHEN "confirmation_time" > "decision_time" THEN "confirmation_time"
    WHEN "decision_time" < '23:00' THEN to_char(("decision_time"::time + interval '1 hour'), 'HH24:MI')
    ELSE '23:30'
  END;--> statement-breakpoint
UPDATE "app_settings" SET
  "default_confirmation_days_before" = "default_decision_days_before",
  "default_confirmation_time" = CASE
    WHEN "default_confirmation_time" > "default_decision_time" THEN "default_confirmation_time"
    WHEN "default_decision_time" < '23:00' THEN to_char(("default_decision_time"::time + interval '1 hour'), 'HH24:MI')
    ELSE '23:30'
  END;