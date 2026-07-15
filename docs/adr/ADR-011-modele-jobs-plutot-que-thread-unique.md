# ADR-011 : Modèle "jobs" (N exécutions par règle) plutôt qu'un thread unique par semaine

- **Statut** : accepted
- **Date** : 2026-07-15

## Contexte

Le modèle initial identifiait un thread LangGraph par `${bookingRuleId}:${weekKey}` : une seule exécution possible par règle et par semaine calendaire. Un premier correctif ("Nouveau job") avait ajouté un compteur `runToken` pour permettre d'abandonner ce thread et d'en repartir un vierge — mais ce modèle restait **un seul run actif à la fois**.

À l'usage réel (tests manuels répétés), ce modèle s'est révélé trop contraint : le besoin est de pouvoir avoir **plusieurs jobs en parallèle** pour une même règle, consulter un historique de tous les jobs passés, et interagir individuellement avec chacun (relancer une étape, annuler un sondage envoyé par erreur, re-consulter le tally des votes qui arrivent progressivement dans le temps).

## Décision

Remplacer le thread unique par règle+semaine par une table `job_runs` (Postgres) : un job = une exécution indépendante du pipeline pour une date cible donnée. Le thread LangGraph devient `${bookingRuleId}:${jobRun.id}`. Une règle peut avoir un nombre arbitraire de jobs, passés ou en cours, consultables dans un historique (`/rules/:id/events`) avec une page de détail par job (`/rules/:id/jobs/:jobId`).

Le cron (déclenchement automatique hebdomadaire) crée ou retrouve son propre job par date cible (idempotent si `pollCron`/`decisionCron` se déclenchent deux fois le même jour), ce qui permet aux jobs manuels de test et aux jobs cron réels de coexister sans interférence.

## Raisons

- Colle au besoin réel exprimé : "on peut avoir plusieurs jobs en même temps", avec un historique et des actions par job (relancer, annuler, re-consulter) — un compteur `runToken` unique ne le permettait pas.
- `job_runs` dénormalise `pollRequestId`/`pollMsgId` dès l'envoi du sondage, permettant de consulter le tally des votes ou d'annuler un sondage (`delete_message`) sans repasser par une lecture Redis/LangGraph.
- Reste dans l'esprit de [ADR-006](./ADR-006-pas-de-moteur-workflow-generique.md) : plusieurs *exécutions* d'un pipeline fixe, pas un pipeline reconfigurable.

## Conséquences

- Supprime la colonne `run_token` ajoutée quelques heures plus tôt sur `booking_rules`, remplacée par la table `job_runs` (migration `0002_right_hercules.sql`).
- L'annulation d'un sondage (`delete_message`) nécessite le `msgId` WhatsApp du sondage, que huddle-bot ne renvoyait pas via `ask_poll`/`get_responses` avant modification côté huddle-bot (voir le commit `feat(mcp): expose poll msgId to enable delete_message on polls` dans ce repo sibling).
- Au passage, un bug réel a été découvert et corrigé dans `collectVotes.ts` : le code filtrait les réponses de `get_responses` sur des champs (`jid`/`name`/`status`) qui ne correspondaient pas à la forme réelle de la réponse huddle-bot (`member`/`phone`/`statut`), si bien que **tous les votes étaient silencieusement ignorés** (`confirmedPlayerIds` toujours vide) depuis le début.
