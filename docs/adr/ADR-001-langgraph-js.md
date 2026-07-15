# ADR-001 : LangGraph.js comme framework d'orchestration

- **Statut** : accepted
- **Date** : 2026-07-11

## Contexte

Le pipeline (SendPoll → CollectVotes → BookSlots → Announce) a besoin d'un enchaînement d'étapes avec pauses longues (attente de la fenêtre de décision, attente d'une confirmation humaine "go" pouvant durer plusieurs heures) et d'une reprise fiable après un redémarrage de pod pendant une pause.

## Décision

Utiliser **LangGraph.js** (`@langchain/langgraph`) plutôt qu'une stack Python/FastAPI ou une state machine maison.

## Raisons

- Garder une stack TypeScript cohérente avec l'écosystème existant (huddle-bot et resa-squash sont déjà en TS).
- LangGraph a un port JS officiel qui couvre nativement les besoins : `StateGraph`, human-in-the-loop (`interrupt()` / `Command({resume})`), checkpointing pluggable.
- Évite de réinventer une state machine persistante avec reprise sur crash.

## Conséquences

- Dépendance à un package encore jeune côté JS (le port Python est plus mature) — un bug du checkpointer Redis a d'ailleurs été rencontré en cours de route (voir [ADR-010](./ADR-010-snapshot-next-plutot-que-interrupts.md)).
- Le pipeline est modélisé comme un graphe à 6 nœuds (`sendPoll`, `waitForDecisionWindow`, `collectVotes`, `bookSlots`, `waitForGoConfirmation`, `announce`) avec 2 points de pause (`interrupt()`), voir `apps/worker/src/graph/buildGraph.ts`.
