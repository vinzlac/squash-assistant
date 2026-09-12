# Architecture Decision Records

Format utilisé : [MADR (Markdown Architectural Decision Records)](https://adr.github.io/madr/).

```
ADR-NNN-titre-court.md
```

Statuts possibles : `proposed` | `accepted` | `deprecated` | `superseded by ADR-NNN`

| # | Titre | Statut |
|---|-------|--------|
| [001](./ADR-001-langgraph-js.md) | LangGraph.js comme framework d'orchestration | accepted |
| [002](./ADR-002-redis-checkpointer-dedie.md) | Redis self-hosted dédié comme checkpointer LangGraph | accepted |
| [003](./ADR-003-delegation-logique-metier-mcp.md) | Délégation de la logique métier aux MCP externes (huddle-bot, resa-squash) | accepted |
| [004](./ADR-004-dry-run-et-validation-humaine.md) | Dry-run systématique + validation humaine ("go") avant toute écriture | accepted |
| [005](./ADR-005-scheduler-interne-node-cron.md) | Scheduler interne (node-cron) plutôt qu'un CronJob K8s | accepted |
| [006](./ADR-006-pas-de-moteur-workflow-generique.md) | Pas de moteur de workflow générique (pipeline fixe, pas de type n8n) | accepted |
| [007](./ADR-007-coexistence-openclaw.md) | Coexistence avec l'agent OpenClaw existant (pas de fusion ni de remplacement) | accepted |
| [008](./ADR-008-monorepo-postgres-drizzle.md) | Monorepo npm workspaces + Postgres/Drizzle pour la config et les events | accepted |
| [009](./ADR-009-pas-auth-applicative.md) | Pas d'authentification applicative (UI + API interne) | accepted |
| [010](./ADR-010-snapshot-next-plutot-que-interrupts.md) | Détection de pause via `snapshot.next`, pas `tasks[].interrupts` | accepted |
| [011](./ADR-011-modele-jobs-plutot-que-thread-unique.md) | Modèle "jobs" (N exécutions par règle) plutôt qu'un thread unique par semaine | accepted |
| [012](./ADR-012-migrations-automatiques-initcontainer.md) | Migrations Postgres appliquées automatiquement via un initContainer | accepted |
| [013](./ADR-013-multi-creneaux-horaires-repartition-des-responsabilites.md) | Sondage multi-créneaux horaires — répartition des responsabilités entre huddle-bot, resa-squash et squash-assistant | accepted |
| [014](./ADR-014-verification-disponibilite-et-versionnement-des-regles.md) | Vérification de disponibilité avant plan (escalade min/max, fenêtre de repli, alerte capacité) + snapshot versionné de la règle par job — tout dans squash-assistant, aucun changement resa-squash | accepted |
| [015](./ADR-015-extraction-llm-description-vers-parametres-de-regle.md) | Extraction LLM (Anthropic Claude, tool-use forcé) : description en français → paramètres de règle — 1ère intégration LLM du projet, hors chemin d'exécution du pipeline | accepted |
| [016](./ADR-016-prete-noms-substitution-quota-titulaire.md) | Prête-noms (`substituteBookers`) en repli du quota titulaire | accepted |
| [017](./ADR-017-option-sondage-prete-nom-volontaire.md) | Option de sondage "prête-nom volontaire", prioritaire sur les prête-noms par défaut | accepted |
| [018](./ADR-018-moteur-de-plan-de-reservation-local.md) | Moteur de plan de réservation rapatrié côté squash-assistant — resa-squash redevient un service de réservation unitaire | accepted |
| [019](./ADR-019-simulateur-scenarios-reservation.md) | Simulateur de scénarios de réservation pour valider le moteur local avant déploiement | accepted |
| [020](./ADR-020-listener-nats-whatsapp-events.md) | Listener NATS dédié pour les events WhatsApp résa (relais Vincent All) | accepted |
| [021](./ADR-021-sse-live-refresh-et-admin-listener.md) | Live refresh SSE page job + admin listener (historique PG, filtres relay WhatsApp) | accepted |
| [022](./ADR-022-preferences-joueurs-min-max-effectifs.md) | Préférences joueurs min/max créneaux effectifs (distincts du plafond TeamR de la règle) | accepted |
| [023](./ADR-023-unification-ci-build-push-race-condition.md) | Unification des 3 workflows CI build-push (worker/ui/listener) — fin de la race condition GitOps + path-filtering | accepted |
| [024](./ADR-024-joker-reservation-joueur-refuse.md) | Joker de réservation quand TeamR refuse un joueur (pas réinscrit, ou quota atteint) | accepted |
| [025](./ADR-025-resolution-ids-joueurs-couche-presentation.md) | Résolution des identifiants joueurs à la couche présentation (moteur de plan agnostique de l'annuaire) | accepted |
| [026](./ADR-026-qr-acces-club-dans-whatsapp.md) | QR d'accès au club envoyé dans le groupe WhatsApp (tools MCP `get_booking_qr` + `send_image`, lien éphémère régénéré à chaque envoi) | accepted |
| [027](./ADR-027-reservation-partielle-sans-rollback.md) | Réservation réelle partielle : plus de rollback tout-ou-rien, les lignes refusées sont conservées comme refus et signalées (WhatsApp, Telegram, UI) | accepted |
| [028](./ADR-028-cascade-prete-noms-joker-a-la-reservation.md) | Cascade prête-noms puis joker à la réservation réelle (même process qu'au plan) ; la vérification des crédits du joker au plan est abandonnée, TeamR seul juge | accepted |
| [029](./ADR-029-source-prete-noms-volontaires-sondage.md) | Source des prête-noms limitée aux volontaires du sondage ; `substituteBookers` conservé mais dormant, le joker reste le seul prête-nom permanent | accepted |
| [030](./ADR-030-planification-pilotee-par-date-cible.md) | Planification pilotée par la date cible : `targetWeekday` + décalages N/M + heures, crons dérivés, migration avec conversion des règles | accepted |
| [031](./ADR-031-reservation-toujours-forcee.md) | Réservation toujours forcée (`force: true` sur `reserve_slot`) : squash-assistant décide seul du moment de réserver, jamais de planification resa-squash | accepted |
| [032](./ADR-032-fermeture-tardive-cascade-worker.md) | Fermeture PUC déclarée tardivement : création + cascade d'arrêt des jobs portées par le worker, thread LangGraph orphelin, relecture du job avant toute reprise « go » | accepted |
