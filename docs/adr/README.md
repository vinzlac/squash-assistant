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
