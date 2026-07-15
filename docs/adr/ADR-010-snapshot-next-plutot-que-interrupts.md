# ADR-010 : Détection de pause via `snapshot.next`, pas `tasks[].interrupts`

- **Statut** : accepted
- **Date** : 2026-07-15

## Contexte

L'UI a besoin de savoir sur quel nœud un job LangGraph est en pause (`waitForDecisionWindow` ou `waitForGoConfirmation`) pour afficher le bon état du pipeline visuel. L'API naturelle pour ça est `graph.getState(config).tasks[].interrupts`.

En observant en production un job affiché à tort comme "tout terminé" alors qu'il était encore en pause à l'étape 2, une investigation en lecture seule (inspection directe des documents JSON dans Redis via `redis-cli JSON.GET`, comparée à un appel `graph.getState()` frais) a révélé une incohérence `checkpoint_ns` (`""` sur le document `checkpoint_write` contenant l'interrupt, `"__empty__"` sur le checkpoint principal) empêchant `@langchain/langgraph-checkpoint-redis` de faire la jointure entre les deux — `tasks[].interrupts` revient donc vide même quand l'interrupt existe réellement.

## Décision

Dériver l'état de pause (`PausedOn`) depuis `snapshot.next` (liste des prochains nœuds à exécuter) plutôt que depuis `snapshot.tasks[].interrupts`, voir `pausedOnFromSnapshot` dans `apps/worker/src/scheduler/scheduler.ts`.

## Raisons

- `next` reste fiable indépendamment du bug de jointure `checkpoint_ns` du package.
- Le pipeline n'a que deux nœuds de pause connus (`waitForDecisionWindow`, `waitForGoConfirmation`) — vérifier leur présence dans `next` suffit, sans avoir besoin du payload détaillé de l'interrupt.

## Conséquences

- Si un futur nœud de pause est ajouté au graphe, il faut penser à l'ajouter explicitement dans `pausedOnFromSnapshot`.
- Le bug du package reste présent en amont (non contourné à sa source) — à réévaluer si une version corrigée de `@langchain/langgraph-checkpoint-redis` est publiée.
