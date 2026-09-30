ALTER TABLE "app_settings" ALTER COLUMN "default_confirmation_days_before" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "default_confirmation_time" SET DEFAULT '10:30';--> statement-breakpoint
ALTER TABLE "booking_rules" ALTER COLUMN "confirmation_days_before" SET DEFAULT 0;--> statement-breakpoint
-- Jour des réservations (date cible), à 10:30. Si la décision est ce même jour à 10:30 ou après, l'heure reste après elle.
UPDATE "booking_rules" SET
  "confirmation_days_before" = 0,
  "confirmation_time" = CASE
    WHEN "decision_days_before" = 0 AND "decision_time" >= '10:30' AND "decision_time" < '23:00'
      THEN to_char(("decision_time"::time + interval '1 hour'), 'HH24:MI')
    WHEN "decision_days_before" = 0 AND "decision_time" >= '23:00' THEN '23:30'
    ELSE '10:30'
  END;--> statement-breakpoint
UPDATE "app_settings" SET
  "default_confirmation_days_before" = 0,
  "default_confirmation_time" = CASE
    WHEN "default_decision_days_before" = 0 AND "default_decision_time" >= '10:30' AND "default_decision_time" < '23:00'
      THEN to_char(("default_decision_time"::time + interval '1 hour'), 'HH24:MI')
    WHEN "default_decision_days_before" = 0 AND "default_decision_time" >= '23:00' THEN '23:30'
    ELSE '10:30'
  END;