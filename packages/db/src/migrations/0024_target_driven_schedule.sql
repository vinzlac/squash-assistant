-- ADR-030 : planification pilotée par la date cible. Les crons stockés (poll_cron,
-- decision_cron) et target_weekday_offset sont convertis en jour cible + décalages en jours
-- + heures, puis supprimés. Toute ligne dont l'un des crons n'est pas exactement "M H * * D"
-- (D dans 0-6) ou dont l'offset est < 1 est traitée comme sentinelle : valeurs neutres, règle
-- désactivée.
ALTER TABLE "booking_rules" ADD COLUMN "target_weekday" integer;--> statement-breakpoint
ALTER TABLE "booking_rules" ADD COLUMN "poll_days_before" integer;--> statement-breakpoint
ALTER TABLE "booking_rules" ADD COLUMN "poll_time" text;--> statement-breakpoint
ALTER TABLE "booking_rules" ADD COLUMN "decision_days_before" integer;--> statement-breakpoint
ALTER TABLE "booking_rules" ADD COLUMN "decision_time" text;--> statement-breakpoint
-- 1) Sentinelles (jour de semaine '*') : règle désactivée, valeurs neutres.
UPDATE "booking_rules" SET
  "target_weekday" = 0,
  "poll_days_before" = 7,
  "poll_time" = '00:00',
  "decision_days_before" = 7,
  "decision_time" = '00:00',
  "enabled" = false
WHERE "poll_cron" !~ '^\d{1,2} \d{1,2} \* \* [0-6]$'
   OR "decision_cron" !~ '^\d{1,2} \d{1,2} \* \* [0-6]$'
   OR "target_weekday_offset" < 1;--> statement-breakpoint
-- 2) Conversion des crons hebdomadaires réels.
UPDATE "booking_rules" SET
  "poll_time" = lpad(split_part("poll_cron", ' ', 2), 2, '0') || ':' || lpad(split_part("poll_cron", ' ', 1), 2, '0'),
  "decision_time" = lpad(split_part("decision_cron", ' ', 2), 2, '0') || ':' || lpad(split_part("decision_cron", ' ', 1), 2, '0'),
  "target_weekday" = (split_part("poll_cron", ' ', 5)::int + "target_weekday_offset") % 7,
  "poll_days_before" = "target_weekday_offset",
  "decision_days_before" = "target_weekday_offset"
    - ((split_part("decision_cron", ' ', 5)::int - split_part("poll_cron", ' ', 5)::int + 7) % 7)
WHERE "target_weekday" IS NULL;--> statement-breakpoint
-- 3) Résultat négatif = décision configurée avant le sondage dans la semaine (incohérent dans
-- l'ancien modèle : elle visait une autre date cible) → repli « même jour que le sondage ».
UPDATE "booking_rules" SET "decision_days_before" = "poll_days_before"
WHERE "decision_days_before" < 0;--> statement-breakpoint
ALTER TABLE "booking_rules" ALTER COLUMN "target_weekday" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_rules" ALTER COLUMN "poll_days_before" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_rules" ALTER COLUMN "poll_time" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_rules" ALTER COLUMN "decision_days_before" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_rules" ALTER COLUMN "decision_time" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_rules" DROP COLUMN "poll_cron";--> statement-breakpoint
ALTER TABLE "booking_rules" DROP COLUMN "decision_cron";--> statement-breakpoint
ALTER TABLE "booking_rules" DROP COLUMN "target_weekday_offset";
