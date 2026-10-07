# ADR-036 – Rappel WhatsApp avant le match, déclenché par un tick global

**Status:** accepted
**Date:** 2026-10-05
**Spec:** [2026-10-05-rappel-avant-match-design.md](../superpowers/specs/2026-10-05-rappel-avant-match-design.md)

## Contexte

La confirmation WhatsApp (étape 5, ADR-033/035) part le jour de la décision. Jusqu'à 5 jours la séparent du match : les joueurs oublient terrain, heure et partenaires, et n'ont plus de QR valide. Il faut un rappel le jour même, X minutes (défaut 120, ±10) avant le premier créneau réellement réservé. Cette heure dépend des créneaux pris chaque semaine : aucun cron fixe par règle ne peut la porter.

## Décision

1. **Tick global `* * * * *` (Europe/Paris)**, créé une seule fois dans `startCronRegistry`, hors registre par règle (conservé par `reloadScheduler`). À chaque tick, `triggerStartReminders` lit les règles actives avec rappel activé, le job actif du jour (`findActiveJobRunForDate`), puis l'état LangGraph de ce seul job. Le tick n'a **pas de garde anti-chevauchement** : la réservation atomique (point 5) empêche déjà tout doublon, et un garde pouvait bloquer le tick indéfiniment.
2. **Décision pure** `evaluateStartReminder` (états `disabled/skipped/waiting/due/sent/missed`, priorité fixe), partagée avec l'API status de l'UI (étape 6) — l'UI ne recalcule rien.
3. **Heure en minutes, heure murale de Paris** (`Intl`) : l'heuristique « +02:00 d'avril à octobre » (`slotStartDateIsoHeuristicParis`) est fausse après le passage à l'heure d'hiver (25/10/2026) et décalait le rappel d'une heure.
4. **Décalage ±10 min dérivé d'un hash de l'id du job** (FNV-1a) : stable d'un tick à l'autre et après redémarrage, rien à stocker.
5. **Réservation atomique avant envoi** (`UPDATE job_runs SET start_reminder_sent_at … WHERE … IS NULL RETURNING`) ; remise à `NULL` si `sendMessage` échoue, nouvel essai chaque minute jusqu'au premier créneau. Le Deployment worker est en `replicas: 1` sans stratégie explicite : pendant un déploiement progressif deux pods coexistent, d'où la réservation **avant** l'envoi plutôt qu'un marquage après. Au plus un message par job. Limites assumées : un timeout ambigu de `sendMessage` peut doubler le message ; un pod tué entre réservation et envoi perd le rappel.
6. **Règle live pour les réglages** (activation, délai, destinataire, `decisionDaysBefore`) ; **règle figée du job** (`status.values.bookingRule`, repli `job.ruleSnapshot`) pour le contenu du message. Écart volontaire avec la confirmation, qui passe la règle live au constructeur de message.
7. Pas de rappel si `decisionDaysBefore = 0` ; en dry-run, pas de rappel vers le groupe du sondage.

## Alternatives écartées

- `setTimeout` posé à la fin de l'étape 4 : perdu au redémarrage du pod (jusqu'à 5 jours d'attente), reprise au boot et annulation à l'édition de la règle à écrire.
- Cron par règle à heure fixe : l'heure du premier créneau change d'une semaine à l'autre.

## Conséquences

- Migration `0032` : `booking_rules.start_reminder_enabled` (défaut `false`), `booking_rules.start_reminder_minutes_before` (défaut 120), `job_runs.start_reminder_sent_at`. Appliquée par l'initContainer ([ADR-012](./ADR-012-migrations-automatiques-initcontainer.md)).
- Une requête par minute (plus une par règle éligible) ; Redis seulement pour 0 à 2 jobs par jour.
- `START_REMINDER_SINCE` (`2026-10-07T00:00:00Z`) : les jobs créés avant la mise en production affichent « — » à l'étape 6, jamais « non envoyé ».
- Les logs Telegram de saut ou d'échec d'envoi sont dédupliqués par un `Set` en mémoire : perdu au redémarrage, au pire un log de plus.
- Délai réglable de 30 à 360 minutes (formulaire de règle, refus explicite hors bornes).
