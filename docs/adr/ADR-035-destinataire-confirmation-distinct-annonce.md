# ADR-035 – Destinataire de la confirmation (étape 5) distinct de celui de l'annonce

**Status:** accepted
**Date:** 2026-10-05

## Contexte

Depuis ADR-033, la confirmation WhatsApp du jour où la réservation est prise (et ses QR
d'accès, ADR-026) partait vers `reservationNotifyWhatsappGroupJid` — le même groupe que
l'annonce de l'étape 4, avec repli sur le groupe du sondage.

Pendant les essais, on veut pouvoir envoyer l'annonce sur le groupe de test, mais la
confirmation (et ses QR) sur le groupe d'origine, ou l'inverse. Un seul réglage ne le permet
pas.

## Décision

1. **Nouveau champ `BookingRule.confirmationNotifyWhatsappGroupJid`** (colonne
   `confirmation_notify_whatsapp_group_jid`, nullable). `null` ou blanc = groupe du sondage
   (`whatsappGroupJid`). Même sémantique que le réglage de l'annonce.
2. **Les deux réglages sont indépendants.** Modifier l'un ne déplace pas l'autre.
3. **Périmètre exact :**
   - suit `confirmationNotifyWhatsappGroupJid` : la confirmation du jour J **et** les QR
     qu'elle renvoie (`triggerBookingConfirmation`, `scheduler.ts`) ;
   - reste sur `reservationNotifyWhatsappGroupJid` : l'annonce (étape 4), les QR envoyés
     avec l'annonce, la synthèse votes/réservations du groupe de test, l'épinglage de
     l'annonce (ADR-034) ;
   - reste sur le groupe du sondage : le sondage et son épinglage, l'annulation pour
     fermeture du club.
4. **Résolveur** `resolveConfirmationNotifyJid(rule)` (`announce.ts`), calqué sur
   `resolveReservationNotifyJid`. Pas de relecture « live » dans le scheduler : `cronRegistry`
   relit déjà la règle avant `onConfirmation`.
5. **Migration `0031`** : ajoute la colonne puis **recopie** `reservation_notify_whatsapp_group_jid`
   dans la nouvelle colonne pour les règles existantes. Aucun changement de comportement au
   déploiement ; le passage au groupe d'origine se fait ensuite dans l'UI (appliquée
   automatiquement par l'initContainer, ADR-012).
6. **UI** : second champ « Groupe de confirmation des réservations » dans `RuleForm`, via
   `ReservationNotifyGroupField` rendu paramétrable (noms de champs uniques par instance).
   Lecture du couple mode/JID factorisée dans `parseNotifyGroup`.

## Conséquences

- Les règles qui avaient un groupe de test pour l'annonce gardent le même destinataire pour
  la confirmation tant qu'on ne le change pas (recopie de la migration).
- Une règle neuve a deux destinataires à `null` = groupe d'origine, comme avant.
- Amende ADR-033 (destinataire de la confirmation) ; les QR de l'étape 5 restent ceux
  d'ADR-026, redemandés à chaque confirmation.
- Un job créé avant la migration n'a pas le champ dans son snapshot : sans incidence, la
  confirmation lit la règle live.

## Références

- [ADR-033](./ADR-033-confirmation-whatsapp-jour-cible.md) — confirmation le jour de la décision.
- [ADR-026](./ADR-026-qr-acces-club-dans-whatsapp.md) — QR d'accès au club dans WhatsApp.
- [ADR-034](./ADR-034-epinglage-whatsapp-sondage-annonce.md) — épinglage (annonce uniquement).
- [ADR-012](./ADR-012-migrations-automatiques-initcontainer.md) — migrations automatiques.
