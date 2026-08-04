# ADR-021 – Live refresh SSE et admin listener

**Status:** accepted (partie A) ; partie B *planned*
**Date:** 2026-08-04

## Contexte

ADR-020 a livré le listener NATS (`apps/listener`) avec relais WhatsApp vers Vincent All. La phase 2 prévue (« rafraîchissement live de l'UI ») était initialement évoquée en WebSocket ; le besoin concret est de mettre à jour l'aperçu `pollTally` sur la page job quand un vote arrive, sans action manuelle.

Contraintes : pas d'Ingress sur le listener ; l'UI est déjà protégée par ForwardAuth Authentik ; le tally reste servi par le worker (`getPollTally`) — pas de duplication de la logique huddle-bot côté client.

## Décision — Partie A : SSE live refresh (*implémenté*)

### 1. SSE plutôt que WebSocket

`GET /events` sur le serveur HTTP listener existant (`:8081`, ClusterIP). Fan-out mémoire (`sseHub`) ; keepalive commentaire `: ping` toutes les ~20 s. Le navigateur consomme via `EventSource` (reconnexion implicite), pas de WebSocket natif listener→navigateur.

### 2. Proxy UI, pas d'exposition directe du listener

Route Handler Next.js `GET /api/resa-events` pipe le stream vers `LISTENER_INTERNAL_URL/events`. L'authentification repose sur ForwardAuth déjà en place sur l'UI — le listener n'a pas d'auth propre.

### 3. Refresh serveur, pas de tally client-side

Le payload SSE (`eventType`, `chatJid`, `actor`, `pollName`, `selectedOptions`, `occurredAt`) sert uniquement à décider **si** rafraîchir. Le composant `ResaEventsLive` compare `chatJid` au `whatsappGroupJid` de la règle du job ; match → debounce 1500 ms → `router.refresh()`. Pas de reconstruction locale du tally depuis le payload SSE.

### 4. Ordre et résilience dans `onResaEvent` (étape A)

Relay WhatsApp Vincent All d'abord (`await`), puis broadcast SSE best-effort (échec loggé, ne nak pas JetStream).

### 5. Périmètre UI

Montage sur la page job uniquement (`/rules/[id]/jobs/[jobId]`). La page historique des jobs (`/rules/[id]/events`) reste sans live refresh SSE à cette étape.

## Décision — Partie B : admin historique + filtres relay (*planned, Tasks 6–8*)

À implémenter dans la même initiative, pas encore livré au moment de cette ADR :

1. **Persistance PG** — table `whatsapp_resa_events` (idempotence sur `event_id` JetStream).
2. **Settings relay** — table `listener_relay_settings` (4 booléens par `eventType`, défaut `true`) ; le relais Vincent All respecte ces filtres, **pas** le broadcast SSE (l'UI live voit tout l'allowlist résa).
3. **Réordonnancement `onResaEvent`** — persist PG (échec → nak) → broadcast SSE → relay WhatsApp si type activé.
4. **Page admin `/listener`** — historique paginé + cases à cocher filtres (`requireAdmin`).

Documentation fonctionnelle complète de la partie B prévue en Task 9 (`docs/spec/regles-fonctionnelles.md`).

## Raisons

- SSE + proxy UI réutilise l'auth existante et évite d'exposer le listener au réseau externe.
- `router.refresh()` minimise le scope (pas de state client du tally) et garantit la cohérence avec `getPollTally`.
- Debounce 1500 ms évite N refreshes sur une rafale de votes.
- Partie B différée : la valeur immédiate (suivi des votes sur la page job) ne dépend pas de la persistance PG.

## Conséquences

- `apps/listener/src/sseHub.ts`, `httpServer.ts` : hub SSE + endpoint `/events`.
- `apps/ui/src/app/api/resa-events/route.ts` : proxy SSE.
- `apps/ui/src/app/rules/[id]/jobs/[jobId]/ResaEventsLive.tsx` : client EventSource.
- `kubernetes/listener-deployment.yaml` : Service ClusterIP ; `LISTENER_INTERNAL_URL` sur le Deployment UI.
- ADR-020 conséquence « Phase 2 WebSocket » remplacée par cette ADR (SSE via proxy UI).
- Spec détaillée : `docs/superpowers/specs/2026-08-04-listener-sse-live-refresh-design.md`.
