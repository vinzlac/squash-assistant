# ADR-003 : Délégation de la logique métier aux MCP externes

- **Statut** : accepted
- **Date** : 2026-07-11

## Contexte

Le pipeline a besoin (1) d'envoyer/lire des sondages WhatsApp et d'interpréter les réponses (oui/non/ambigu), et (2) de calculer l'allocation des créneaux de squash (quel court, quels joueurs, dans quel ordre de priorité). Ces deux capacités existent déjà, exposées en MCP par deux services externes : **huddle-bot** (WhatsApp) et **resa-squash** (réservation).

## Décision

squash-assistant **ne réimplémente pas** l'allocation de créneaux ni l'interprétation des votes. Il consomme ces capacités via les tools MCP `plan_group_bookings` (resa-squash) et `ask_poll`/`get_responses` (huddle-bot), et se contente d'orchestrer l'enchaînement + la validation humaine + le formatage de l'annonce finale.

## Raisons

- Ces deux logiques sont déjà écrites, testées et utilisées en production par l'agent OpenClaw existant sur ce même processus métier (voir [ADR-007](./ADR-007-coexistence-openclaw.md)) — les réimplémenter serait dupliquer un risque de bug déjà résolu ailleurs.
- Garde squash-assistant volontairement mince : scheduler + enchaînement des 4 étapes + validation humaine + regroupement des créneaux adjacents pour l'affichage (repris de `slot-merge.ts` côté resa-squash), rien de plus.

## Conséquences

- squash-assistant est fortement couplé aux schémas de tools de ces deux MCP — un changement de schéma côté huddle-bot ou resa-squash impacte directement ce repo (constaté : `get_responses` renvoie `member`/`phone`/`statut`, pas `jid`/`name`/`status` comme le code le supposait initialement — voir le commit `feat: replace single weekly thread with a job history model`, qui corrige ce bug).
- Certains champs de `BookingRule` (`maxCourtsPerSlot`, `minPlayersPerCourt`, `maxPlayersPerCourt`, `preferMinPlayersPerCourt`, `courtPriority`) sont stockés mais pas encore branchés à un paramètre `plan_group_bookings` équivalent (n'existe pas côté resa-squash aujourd'hui) — à revisiter si le tool évolue.
