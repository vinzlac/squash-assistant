# ADR-021 – Live refresh SSE et admin listener

**Status:** accepted
**Date:** 2026-08-04

## Contexte

ADR-020 a livré le listener NATS (`apps/listener`) avec relais WhatsApp vers Vincent All. La phase 2 prévue (« rafraîchissement live de l'UI ») était initialement évoquée en WebSocket ; le besoin concret est de mettre à jour l'aperçu `pollTally` sur la page job quand un vote arrive, sans action manuelle, puis de superviser ces events et de filtrer le relais WhatsApp par type.

Contraintes : pas d'Ingress sur le listener ; l'UI est déjà protégée par ForwardAuth Authentik ; le tally reste servi par le worker (`getPollTally`) — pas de duplication de la logique huddle-bot côté client.

## Décision — Partie A : SSE live refresh

### 1. SSE plutôt que WebSocket

`GET /events` sur le serveur HTTP listener existant (`:8081`, ClusterIP). Fan-out mémoire (`sseHub`) ; keepalive commentaire `: ping` toutes les ~20 s. Le navigateur consomme via `EventSource` (reconnexion implicite), pas de WebSocket natif listener→navigateur.

### 2. Proxy UI, pas d'exposition directe du listener

Route Handler Next.js `GET /api/resa-events` pipe le stream vers `LISTENER_INTERNAL_URL/events`. L'authentification repose sur ForwardAuth déjà en place sur l'UI — le listener n'a pas d'auth propre.

### 3. Refresh serveur, pas de tally client-side

Le payload SSE (`eventType`, `chatJid`, `actor`, `pollName`, `selectedOptions`, `occurredAt`) sert uniquement à décider **si** rafraîchir. Le composant `ResaEventsLive` compare `chatJid` au `whatsappGroupJid` de la règle du job ; match → debounce **1500 ms** → `router.refresh()`. Pas de reconstruction locale du tally depuis le payload SSE.

### 4. Périmètre UI (live refresh)

Montage sur la page job uniquement (`/rules/[id]/jobs/[jobId]`). La page historique des jobs (`/rules/[id]/events`) reste sans live refresh SSE.

## Décision — Partie B : admin historique + filtres relay

### 1. Persistance PG — table `whatsapp_resa_events`

Chaque event résa allowlist est inséré avant broadcast et relay. Colonnes : `event_id` (UNIQUE, idempotence JetStream), `event_type`, `occurred_at`, `chat_jid`/`chat_name`, acteur, `summary` (même esprit que le format relais), `payload` jsonb, `created_at`. Insert `onConflictDoNothing` sur `event_id` — redelivery du même event → une seule ligne historique. **Échec persist → nak JetStream** (comme MCP) pour ne pas perdre l'historique.

### 2. Settings relay — table `listener_relay_settings`

Une seule ligne `id='default'`, quatre booléens (`poll_creation`, `poll_vote_creation`, `poll_vote_update`, `poll_vote_deletion`), défaut `true`. Seed via `INSERT … ON CONFLICT DO NOTHING` au démarrage listener et côté UI (`getRelaySettings`). Refresh périodique en mémoire listener (même intervalle que l'allowlist).

### 3. Réordonnancement `onResaEvent` (partie B remplace l'ordre partie A)

Ordre final :

1. `await persist(event)` — échec → nak
2. `broadcast` SSE — best-effort (échec loggé, pas de nak)
3. `await relay(event)` — **uniquement si** `isRelayTypeEnabled(settings, event.eventType)`

Le broadcast SSE **n'est pas** filtré par `listener_relay_settings` : l'UI live voit tout l'allowlist résa.

### 4. Page admin `/listener`

- **Accès** : page entière réservée aux admins (`isAdmin`, groupe Authentik `squash-admins`). Non-admin → message d'accès refusé, aucune donnée.
- **Navigation** : lien « Listener » sur la home admin (`/`), à côté des paramètres.
- **Filtres relais** : formulaire 4 checkboxes → `updateListenerRelaySettingsAction` avec `requireAdmin` + `revalidatePath('/listener')`.
- **Historique** : requête directe PG (`listResaEvents` + `countResaEvents`), **20** events/page, tri `occurred_at` asc/desc (lien en-tête Date), filtres GET (date pickers du/au, type, groupe via `list_groups`, acteur via membres resa-squash de toutes les `booking_rules` ∪ acteurs déjà en historique), colonnes date (Europe/Paris), type, groupe, acteur, résumé.

Critères de succès partie B (comportement attendu) :

- Events résa allowlist visibles dans `/listener` après réception.
- Décocher un type (ex. `poll_vote_update`) → plus de message WhatsApp pour ce type ; SSE + refresh page job continuent.
- Redelivery JetStream même `event_id` → une seule ligne historique.

## Raisons

- SSE + proxy UI réutilise l'auth existante et évite d'exposer le listener au réseau externe.
- `router.refresh()` minimise le scope (pas de state client du tally) et garantit la cohérence avec `getPollTally`.
- Debounce 1500 ms évite N refreshes sur une rafale de votes.
- Persistance PG avant relay garantit l'historique même si Vincent All est injoignable.
- Filtres relay séparés du SSE : couper le bruit WhatsApp sans impacter le suivi live des votes sur la page job.

## Conséquences

**Partie A**

- `apps/listener/src/sseHub.ts`, `httpServer.ts` : hub SSE + endpoint `/events`.
- `apps/ui/src/app/api/resa-events/route.ts` : proxy SSE.
- `apps/ui/src/app/rules/[id]/jobs/[jobId]/ResaEventsLive.tsx` : client EventSource.
- `kubernetes/listener-deployment.yaml` : Service ClusterIP ; `LISTENER_INTERNAL_URL` sur le Deployment UI.

**Partie B**

- `packages/db/src/schema.ts` : `whatsapp_resa_events`, `listener_relay_settings` + migration.
- `apps/listener/src/persist.ts`, `relaySettings.ts` : persist + gate relay.
- `apps/listener/src/onResaEvent.ts` : ordre persist → broadcast → relay filtré.
- `apps/ui/src/lib/listenerAdmin.ts`, `apps/ui/src/app/listener/page.tsx` : admin historique + filtres.
- `apps/ui/src/app/actions.ts` : `updateListenerRelaySettingsAction`.

**Transversal**

- ADR-020 conséquence « Phase 2 WebSocket » remplacée par cette ADR (SSE via proxy UI).
- Règles fonctionnelles : §7 listener + §3 étape 2 live refresh.
- Spec détaillée : `docs/superpowers/specs/2026-08-04-listener-sse-live-refresh-design.md`.
