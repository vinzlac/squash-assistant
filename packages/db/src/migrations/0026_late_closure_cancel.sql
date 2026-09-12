-- Fermeture PUC déclarée tardivement (spec 2026-09-12) : cause d'annulation et fermeture d'origine
-- posées par la cascade d'arrêt des jobs en cours. Annulation manuelle du sondage : les deux restent NULL.
ALTER TABLE "job_runs" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "club_closure_id" uuid;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_club_closure_id_club_closures_id_fk" FOREIGN KEY ("club_closure_id") REFERENCES "public"."club_closures"("id") ON DELETE set null ON UPDATE no action;