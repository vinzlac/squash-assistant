-- candidateStartTimes remplace l'heure de session unique (sessionStartTime) sur
-- booking_rules et job_runs — plusieurs heures candidates par sondage, cf. ADR-013.
ALTER TABLE "booking_rules" ADD COLUMN "candidate_start_times" jsonb DEFAULT '["18H45"]'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "booking_rules" SET "candidate_start_times" = to_jsonb(ARRAY["session_start_time"]);
--> statement-breakpoint
ALTER TABLE "booking_rules" DROP COLUMN "session_start_time";
--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "candidate_start_times" jsonb;
--> statement-breakpoint
UPDATE "job_runs" SET "candidate_start_times" = to_jsonb(ARRAY["session_start_time"]) WHERE "session_start_time" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_runs" DROP COLUMN "session_start_time";
