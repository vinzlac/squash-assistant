# ADR-008 : Monorepo npm workspaces + Postgres/Drizzle pour la config et les events

- **Statut** : accepted
- **Date** : 2026-07-14

## Contexte

La configuration des règles de réservation (`BookingRule`) vivait initialement dans un fichier `groups.json` versionné, éditable uniquement en redéployant l'image Docker. Le besoin d'une UI d'admin (Phase 4 du plan) impliquait de pouvoir activer/désactiver et éditer une règle à chaud, sans redéploiement.

## Décision

- Passer la config `BookingRule` en **Postgres** (table `booking_rules`, Drizzle ORM), plus un fichier JSON versionné.
- Ajouter une table `events` (log applicatif : `poll` / `collect_votes` / `booking`, statut succès/échec, détail JSON) pour tracer l'exécution par règle.
- Restructurer le repo en **monorepo npm workspaces** : `apps/worker` (scheduler LangGraph), `apps/ui` (Next.js, admin), `packages/db` (schéma Drizzle + client partagés).

## Raisons

- Anticipe directement l'UI Phase 4 : stocker la config dans un fichier copié dans l'image Docker aurait été du travail jeté, il aurait fallu migrer vers un stockage éditable à chaud de toute façon.
- Réutilise le même stack (Postgres + Drizzle) que huddle-bot, déjà éprouvé sur ce cluster.
- Le monorepo permet de partager le schéma Drizzle entre le worker (lecture des règles, écriture des events) et l'UI (CRUD complet) sans dupliquer le code.

## Conséquences

- Deux images Docker distinctes à builder/déployer (`apps/worker`, `apps/ui`), deux workflows GitHub Actions séparés (`build-push.yml`, `build-push-ui.yml`).
- Les migrations Postgres doivent être appliquées explicitement à chaque changement de schéma — voir [ADR-012](./ADR-012-migrations-automatiques-initcontainer.md) pour l'automatisation de cette étape, ajoutée après coup suite à un oubli répété.
