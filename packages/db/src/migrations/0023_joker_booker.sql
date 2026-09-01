-- Joker de réservation (ADR-024) : joueur de repli sans plafond et toujours réinscrit
-- (le gérant du club), utilisé pour remplacer un joueur que TeamR refuse — non réinscrit
-- (resa-squash ADR-011) ou quota de réservations atteint.
ALTER TABLE "booking_rules" ADD COLUMN "joker_booker_id" text;
