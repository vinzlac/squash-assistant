# ADR-012 : Migrations Postgres appliquées automatiquement via un initContainer

- **Statut** : accepted
- **Date** : 2026-07-15

## Contexte

Le déploiement suit un modèle GitOps (CI build+push l'image, commit le nouveau tag dans `kubernetes/deployment.yaml`, Argo CD synchronise). Aucune étape de ce pipeline n'exécutait `packages/db`'s migrations Drizzle : le worker démarrait directement avec `node apps/worker/dist/index.js`. En pratique, les migrations avaient dû être appliquées à la main (port-forward + `npm run db:migrate`) à chaque changement de schéma — constaté à l'usage : Argo CD redéploie l'image mais ne fait jouer aucune migration, le schéma ne suit donc pas le déploiement sans intervention manuelle.

## Décision

Ajouter un `initContainer` (`migrate`) au `Deployment` du worker, utilisant la même image applicative, qui exécute `node packages/db/dist/migrate.js` avant le démarrage du container principal.

## Raisons

- Drizzle ne rejoue que les migrations non encore appliquées (idempotent) — sans risque à chaque redémarrage de pod, y compris hors changement de schéma.
- Le script CI qui met à jour `kubernetes/deployment.yaml` (`sed` sur toute ligne `image: ghcr.io/OWNER/PKG:*`) met déjà à jour **toutes** les lignes correspondantes du fichier, donc l'image de l'initContainer reste automatiquement synchronisée avec celle du container principal sans modification du workflow CI.
- Évite d'introduire un `Job` Kubernetes séparé ou une étape CI supplémentaire (hook ArgoCD PreSync) pour un besoin qui se résout simplement dans le Deployment existant.

## Conséquences

- Chaque redémarrage de pod (déploiement ou crash) ajoute une petite latence de démarrage (connexion Postgres + vérification des migrations).
- Si une migration échoue, le pod reste bloqué en `Init` sans jamais démarrer le container applicatif — comportement voulu (fail-fast) plutôt qu'un démarrage avec un schéma incohérent.
