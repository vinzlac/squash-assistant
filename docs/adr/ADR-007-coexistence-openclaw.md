# ADR-007 : Coexistence avec l'agent OpenClaw existant (pas de fusion ni de remplacement)

- **Statut** : accepted
- **Date** : 2026-07-12

## Contexte

Un agent **OpenClaw** est déjà en production, orchestré par des crons natifs, et consomme les deux mêmes serveurs MCP (huddle-bot, resa-squash) pour exactement le même processus métier en 4 étapes (sondage → lecture des votes → réservation → annonce). Le repo `k3s-homelab` contient un plan équivalent (`plan-squash-auto-openclaw-whatsapp.md`), partiellement réalisé.

## Décision

squash-assistant est une **expérimentation séparée qui coexiste en parallèle** avec l'agent OpenClaw. Le plan OpenClaw n'est ni modifié, ni fusionné, ni rendu obsolète par ce projet.

## Raisons

- squash-assistant explore une manière alternative d'implémenter le même processus (moteur LangGraph.js + scheduler interne, plutôt que crons OpenClaw natifs) — l'objectif est d'évaluer cette approche indépendamment, pas de migrer immédiatement.
- Les deux systèmes peuvent avancer chacun de leur côté sans dépendance ni blocage mutuel.
- Une bascule prématurée aurait forcé une décision (abandon d'OpenClaw ou de squash-assistant) avant d'avoir des données pour la prendre.

## Conséquences

- Risque de double-déclenchement réel si les deux systèmes étaient un jour activés simultanément sur le même groupe WhatsApp — mitigé en pratique par l'usage d'un groupe de test dédié ("Vincent All") pendant toute la phase d'expérimentation, `enabled: false` sur les règles réelles tant que squash-assistant n'est pas validé.
- La décision de suite (passer squash-assistant en usage réel, rester en expérimentation, ou l'abandonner) se prend en Phase 4 du plan, **sans impact** sur le cycle de vie du plan OpenClaw.
