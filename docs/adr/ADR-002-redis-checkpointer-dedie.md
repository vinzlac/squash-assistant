# ADR-002 : Redis self-hosted dédié comme checkpointer LangGraph

- **Statut** : accepted
- **Date** : 2026-07-13 (choix du package résolu le 2026-07-14)

## Contexte

LangGraph a besoin d'un backend de persistance (`BaseCheckpointSaver`) pour survivre à un redémarrage de pod pendant une pause `interrupt()` (attente de la fenêtre de décision, attente du "go").

## Décision

Déployer un Redis **self-hosted dédié** sur K3s (`Deployment` + PVC, sans HA) et utiliser le package **officiel** `@langchain/langgraph-checkpoint-redis` (pas une alternative communautaire envisagée initialement).

## Raisons

- Séparation des responsabilités : l'état du graphe n'a pas à être couplé au Redis Upstash (managé) déjà utilisé par resa-squash.
- Cohérent avec le pattern déjà en place pour Postgres huddle-bot (`Deployment` + PVC dédié plutôt que base partagée).
- Le package officiel a été validé, y compris la reprise après redémarrage pendant un `interrupt()`.

## Conséquences

- Nécessite l'image `redis/redis-stack-server` (RedisJSON + RediSearch), **pas** `redis:7-alpine` — le checkpointer stocke ses documents en JSON et les indexe via RediSearch.
- Le package officiel a un bug de cohérence `checkpoint_ns` (`""` vs `"__empty__"`) entre le checkpoint et ses `checkpoint_write`, qui rend `snapshot.tasks[].interrupts` non fiable — voir [ADR-010](./ADR-010-snapshot-next-plutot-que-interrupts.md) pour le contournement retenu.
