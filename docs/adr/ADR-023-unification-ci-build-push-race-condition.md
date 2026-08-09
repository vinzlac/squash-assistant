# ADR-023 – Unification des workflows CI build-push (fin de la race condition GitOps)

**Status:** accepted
**Date:** 2026-08-09

## Contexte

Le repo avait 3 workflows GitHub Actions séparés — `build-push.yml` (worker), `build-push-ui.yml`, `build-push-listener.yml` — chacun avec son propre `on.push.paths` (`apps/worker/**`, `apps/ui/**`, `apps/listener/**`), mais partageant des chemins communs (`packages/db/**`, `package.json`, `package-lock.json`). Tout commit touchant un de ces chemins partagés (une migration Drizzle, par exemple) déclenchait les 3 workflows en parallèle, et chacun committait/poussait lui-même sa mise à jour de manifeste K8s (`kubernetes/*.yaml`) sur `main` sans coordination.

Le même défaut de conception venait d'être identifié et corrigé sur le repo jumeau `huddle-bot` (même jour, voir son [post-mortem `2026-08-09-gitops-ci-race-condition.md`](https://github.com/vinzlac/huddle-bot/blob/main/docs/post-mortem/2026-08-09-gitops-ci-race-condition.md)) : des jobs parallèles qui committent chacun sur la même branche produisent un rejet `! [rejected] main -> main (fetch first)` de façon récurrente, pas seulement occasionnelle.

## Décision

### 1. Fusion des 3 workflows en un seul, avec matrix

`build-push.yml` build désormais les 3 services (worker/ui/listener) via `strategy.matrix`, sur le même runner `arc-runner-squash-assistant`. `build-push-ui.yml` et `build-push-listener.yml` sont supprimés. Les noms d'image GHCR restent identiques à l'historique (`squash-assistant`, `squash-assistant-ui`, `squash-assistant-listener` — le worker garde son nom sans suffixe) pour ne pas casser les manifestes K8s existants.

### 2. Path-filtering centralisé (`dorny/paths-filter@v3`)

Un job `changes` en amont calcule quel(s) service(s) sont réellement concernés par le commit, avec un repli "tout rebuild" si un chemin partagé change (`packages/db/**`, `package.json`, `package-lock.json`, le workflow lui-même) ou sur `workflow_dispatch` manuel. Chaque job `build` calcule la condition dans un step (`id: gate`) et conditionne chaque step suivant dessus.

### 3. Job GitOps séparé, seul writer git par run

Chaque job `build` n'écrit plus dans git : il publie un artifact (`gitops-<service>` = `fichier|référence d'image`). Un job `gitops` unique en aval (`needs: build`, `if: always() && needs.build.result != 'cancelled'`) télécharge tous les artifacts et applique toutes les mises à jour de manifeste en un seul commit séquentiel, avec une boucle retry en filet de sécurité.

## Raisons

- Un seul writer git par run élimine la race condition structurellement, plutôt qu'un pansement de retry par job.
- Le path-filtering réduit le nombre de builds Docker inutiles (chaque service ne rebuild que si son propre répertoire — ou un chemin partagé — a changé).
- `main` n'est pas protégé sur ce repo (`gh api .../branches/main/protection` → 404) : aucune règle de status check requis à casser en renommant/fusionnant les jobs.

## Conséquences

- **Piège rencontré et corrigé pendant l'implémentation :** le contexte `matrix` n'est pas autorisé dans `jobs.<job_id>.if` (seuls `github`/`inputs`/`needs`/`vars` le sont). Une première version posait la condition de path-filtering directement au niveau job — le workflow entier devenait invalide (run créé avec 0 jobs). Corrigé en déplaçant le calcul dans un step. Toujours valider un changement de workflow avec `actionlint` (`brew install actionlint`) avant de pousser — un simple linter YAML ne détecte pas ce type d'erreur de contexte GitHub Actions.
- `custom-rag` a le même bug de race condition (matrix + GitOps inline par service), pas encore corrigé au 2026-08-09.
- Vérifié en conditions réelles : run avec les 3 services modifiés en même temps (build complet + un seul commit GitOps final).
