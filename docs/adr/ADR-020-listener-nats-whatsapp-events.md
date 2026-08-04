# ADR-020 – Listener NATS dédié pour les events WhatsApp résa

**Status:** accepted
**Date:** 2026-08-04

## Contexte

huddle-bot publie sur JetStream (`stream WHATSAPP_EVENTS`, subjects `homelab.whatsapp.<jid-sanitized>`) tous les events WhatsApp pertinents pour le backoffice (ADR-012 huddle-bot). squash-assistant a besoin d'être notifié en temps réel des events liés aux réservations (sondages et votes) pour deux usages : (1) un relais lisible dans le groupe de test WhatsApp « Vincent All », puis (2) à terme un rafraîchissement live de l'UI via WebSocket.

Le consumer durable `backoffice-consumer` (k3s-homelab) sert déjà l'UI huddle-bot sur le même stream et le même `filter_subject` (`homelab.whatsapp.>`). Étendre ce consumer ou brancher la logique dans `apps/worker` mélangerait des responsabilités hétérogènes (scheduler LangGraph vs bus temps réel ; UI huddle-bot vs squash-assistant).

## Décision

### 1. App dédiée `apps/listener`

Nouveau process Node séparé de `apps/worker` dans le monorepo squash-assistant. Un incident NATS ou MCP du listener ne doit pas impacter les crons du pipeline de réservation.

### 2. Filtrage applicatif sur le payload

- Consumer JetStream avec `filter_subject: homelab.whatsapp.>` (même pattern que `backoffice-consumer`).
- Filtrage métier **en code** après désérialisation du JSON : `eventType ∈ poll_creation | poll_vote_*` et `chat.jid` dans l'allowlist des `booking_rules` `enabled`, en excluant systématiquement le groupe Vincent All (évite une boucle de relais).
- Le type d'event n'est **pas** encodé dans le subject NATS ; seul le champ payload `eventType` fait foi.

### 3. Pas de table Postgres d'audit

JetStream sert de tampon ; le message est acké après envoi MCP réussi. Pas de persistance des events consommés côté squash-assistant pour le MVP.

### 4. Relais via MCP huddle-bot `send_message`

Le résumé texte est posté dans le groupe WhatsApp Vincent All via l'outil MCP huddle-bot `send_message`, même pattern d'authentification que `apps/worker`.

### 5. Consumer durable séparé du backoffice

Consumer JetStream dédié `squash-assistant-listener` sur `WHATSAPP_EVENTS`, indépendant de `backoffice-consumer`. Déclaré en JSON versionné dans k3s-homelab (`kubernetes/nats/consumers/squash-assistant-listener.json`), appliqué via `scripts/setup-nats-consumers.sh`. Le Deployment k3s du listener vit dans ce repo (`kubernetes/listener-deployment.yaml`).

## Raisons

- Séparation des préoccupations : scheduler vs écoute temps réel ; huddle-bot backoffice vs squash-assistant.
- L'allowlist JIDs évolue avec les règles actives — un filtrage applicatif évite de recréer le consumer NATS à chaque changement de règle.
- Un consumer durable dédié permet un replay indépendant et un scaling/opération isolés du backoffice huddle-bot.
- Pas d'audit Postgres : le canal Vincent All est un relais de test/supervision, pas une source de vérité.

## Conséquences

- `apps/listener/` : nouvelle app monorepo (connect NATS, allowlist, filtre, format, relay MCP).
- `kubernetes/listener-deployment.yaml` : Deployment k3s dans squash-assistant (image `ghcr.io/vinzlac/squash-assistant-listener`).
- k3s-homelab : JSON consumer `squash-assistant-listener.json` sur stream `WHATSAPP_EVENTS`.
- `docs/spec/regles-fonctionnelles.md` : règle de relais temps réel documentée.
- Phase 2 (hors MVP) : fan-out WebSocket depuis le même handler `onResaEvent` pour rafraîchir l'UI sans poll HTTP.
- Détail technique : `docs/superpowers/specs/2026-08-04-whatsapp-events-listener-design.md`.
