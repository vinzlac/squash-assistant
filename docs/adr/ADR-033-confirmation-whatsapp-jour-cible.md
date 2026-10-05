# ADR-033 – Confirmation WhatsApp le jour des réservations, à la place du rappel J+1

**Status:** accepted
**Date:** 2026-09-30
**Amendé par:** [ADR-035](./ADR-035-destinataire-confirmation-distinct-annonce.md) — le destinataire de la confirmation n'est plus `reservationNotifyWhatsappGroupJid` mais `confirmationNotifyWhatsappGroupJid`.

## Contexte

L'étape 5 du job était un rappel WhatsApp hors graphe LangGraph, déclenché par un cron
quotidien `5 0 * * *` (vers 00h05–00h15, Paris). Il cherchait un job **créé la veille**
(`JobRun.createdAt`) déjà `finished-announced`. Avec un sondage et une décision à des jours
différents (ADR-030), ce job n'existe pas à ce moment-là : l'étape ne passait jamais au vert.

Le besoin (2026-09-30) : une confirmation dans le groupe de notification des réservations
(`reservationNotifyWhatsappGroupJid`, repli sur le groupe du sondage), **le jour des
réservations** — la date cible, pas le jour où l'étape 4 tourne — à une heure configurable,
par défaut 10:30, dans une fenêtre de ±10 minutes tirée au hasard à chaque envoi. Le message
porte la date, les courts et créneaux réellement pris, et les personnes ayant répondu oui
au sondage.

Une première implémentation (v1.0.0) a recopié le décalage de la décision : pour un match du
mardi avec décision le jeudi à 09:00, l'UI affichait « jeudi à 10:30 ». Ce n'est pas le jour
des réservations. Corrigé en v1.0.2.

## Décision

1. **Le cron quotidien 00h05 disparaît.** La confirmation est un troisième cron dérivé
   (`deriveCrons` → `confirmationCron`), comme le sondage et la décision (ADR-030) :
   `confirmationDaysBefore` + `confirmationTime`. Défaut : `0` (le jour cible) et `10:30`.
2. **Fenêtre ±10 min, nouveau tirage à chaque déclenchement.** Le cron sonne 10 minutes avant
   l'heure configurée ; un délai aléatoire uniforme dans `[0, 20 min)` place l'envoi dans
   `[heure − 10 min, heure + 10 min)`. Rien n'est mémorisé d'une semaine à l'autre.
3. **Le job visé est celui de la date cible** (`computeTargetDate(now, confirmationDaysBefore)`
   + `findActiveJobRunForDate`), pas celui créé la veille. Envoi seulement si le stage est
   `finished-announced` et que `JobRun.nextDayReminderSentAt` est vide. Sinon un log Telegram,
   sans marquer l'envoi (pas de second essai dans la semaine).
4. **La confirmation ne précède pas la décision** : `confirmationDaysBefore` ≤
   `decisionDaysBefore` ; si égalité, `confirmationTime` > `decisionTime`.
5. **Opt-in inchangé.** Le flag `nextDayReminderEnabled` (défaut `false`) et la colonne
   `nextDayReminderSentAt` sont réutilisés. Le nom de colonne reste ; le sens est l'horodatage
   de la confirmation.
6. **Message** `buildBookingConfirmationMessage` : titre `✅ Confirmation — Réservation pour
   <jour>` (ou dry-run), date, courts fusionnés, puis « Oui au sondage ». En réservation
   réelle, les QR sont redemandés (ADR-026) : le lien de l'annonce a expiré.

## Révision (2026-10-01)

Le point 1 ci-dessus (défaut `confirmationDaysBefore = 0`, le jour cible) est remplacé.
« Le jour des réservations » désigne le jour **où** la réservation est prise — le jour de
la décision — et non le jour **pour lequel** on réserve.

1. Le cron de confirmation utilise `decisionDaysBefore` pour le jour, et `confirmationTime`
   pour l'heure. `confirmationDaysBefore` est recopié sur `decisionDaysBefore` à la
   sauvegarde et par la migration `0029`.
2. Même jour que la décision : `confirmationTime` doit être après `decisionTime`. Si l'heure
   configurée (souvent 10:30) est déjà après, elle est conservée. Sinon elle est avancée
   d'une heure après la décision.
3. La recherche du job utilise `computeTargetDate(now, decisionDaysBefore)`, comme le cron
   de décision, pour retrouver la même date cible.

## Conséquences

- Migrations `0027` (colonnes), `0028` (jour cible à 10:30, remplacée) puis `0029`
  (jour de la décision). L'initContainer du worker les applique (ADR-012).
- L'aperçu du bloc Planification et la description générée affichent l'heure suivie de
  « ±10 min ».
- Un créneau déjà passé au moment du déploiement n'est pas rattrapé : le cron ne se rejoue
  pas dans la semaine.
- Les ADR et la spec qui parlaient du « rappel J+1 » comme comportement courant désignent
  désormais cette confirmation. L'historique daté (2026-08-12, 2026-08-23, 2026-09-06) reste
  celui de l'ancien rappel.
