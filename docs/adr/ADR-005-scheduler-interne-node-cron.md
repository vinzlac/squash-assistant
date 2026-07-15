# ADR-005 : Scheduler interne (node-cron) plutôt qu'un CronJob K8s

- **Statut** : accepted
- **Date** : 2026-07-11

## Contexte

Le déclenchement du pipeline suit un cycle cron (sondage le matin, décision le soir), mais le nœud `BookSlots`/`waitForGoConfirmation` doit rester **en attente** potentiellement plusieurs heures après son déclenchement, le temps de recevoir une confirmation "go" sur Telegram.

## Décision

Le worker est un `Deployment` Node.js long-running avec un scheduler **interne** au process (`node-cron`), pas un `CronJob` Kubernetes externe.

## Raisons

- Un `CronJob` K8s termine son pod à la fin de l'exécution — incompatible avec une pause de plusieurs heures en attente humaine.
- Un process long-running avec scheduler interne + checkpointer Redis (voir [ADR-002](./ADR-002-redis-checkpointer-dedie.md)) permet de rester en pause sans consommer de ressources actives, et de reprendre après un redémarrage de pod (voir `recoverPendingGoWaits` dans `apps/worker/src/scheduler/scheduler.ts`).

## Conséquences

- Le worker doit gérer lui-même la logique de reprise au démarrage (rejouer l'attente du "go" pour tout job resté en pause après un crash/redéploiement).
- Pas de contrainte `Recreate` sur le déploiement (contrairement au listener WhatsApp de huddle-bot qui maintient une session unique) : l'orchestrateur ne maintient pas de connexion à état unique, un `RollingUpdate` standard convient.
