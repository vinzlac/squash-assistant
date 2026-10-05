ALTER TABLE "booking_rules" ADD COLUMN "confirmation_notify_whatsapp_group_jid" text;--> statement-breakpoint
-- ADR-035 : la confirmation (étape 5) avait jusqu'ici le même destinataire que l'annonce.
-- On recopie ce destinataire pour ne rien changer au déploiement ; l'utilisateur le modifie ensuite dans l'UI.
UPDATE "booking_rules" SET "confirmation_notify_whatsapp_group_jid" = "reservation_notify_whatsapp_group_jid";
