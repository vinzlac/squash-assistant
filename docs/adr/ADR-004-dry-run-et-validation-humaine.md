# ADR-004 : Dry-run systématique + validation humaine ("go") avant toute écriture

- **Statut** : accepted
- **Date** : 2026-07-11

## Contexte

Le pipeline peut, à terme, réserver de vrais créneaux de squash et annoncer publiquement sur WhatsApp. Pendant la phase POC, aucune réservation réelle ni annonce erronée n'est acceptable.

## Décision

- `BookSlots` appelle toujours `plan_group_bookings` avec `dryRun: true` — `reserve_slot` / `cancel_reservation` ne sont jamais appelés dans le POC.
- Le plan de réservation proposé est envoyé sur Telegram et le pipeline **attend une confirmation explicite "go"** (nœud `waitForGoConfirmation`, `interrupt()`) avant `Announce`.
- Scope `READ_ONLY` sur les deux clés API MCP (huddle-bot, resa-squash) tant que possible.

## Raisons

- Aucune action d'écriture réelle n'est nécessaire pour valider le pipeline en dry-run — limite le blast radius si l'agent se comporte mal (bug de logique, boucle, etc.).
- Reprend un pattern déjà éprouvé sur l'agent OpenClaw en production (dry-run → Telegram → confirmation "go" → écriture).
- Structurer la confirmation comme un nœud `interrupt()` dès maintenant (plutôt qu'un simple log) prépare la bascule vers `READ_WRITE` sans changement d'architecture.

## Conséquences

- Le passage à une vraie réservation (`reserve_slot`) est un changement de scope explicite, différé à une phase ultérieure (Phase 4 du plan), décidé **après** évaluation du POC.
- Toutes les clés API utilisées par squash-assistant sont dédiées au POC et distinctes de celles d'OpenClaw en prod, pour isolation et traçabilité.
