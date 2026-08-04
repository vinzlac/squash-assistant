# Design — Phase 2 : live refresh SSE + admin historique / filtres WhatsApp

**Statut** : approuvé pour passage en plan d'implémentation.
**Date** : 2026-08-04
**Contexte** : suite au MVP listener NATS (`docs/superpowers/specs/2026-08-04-whatsapp-events-listener-design.md`, ADR-020). Relais Vincent All en prod.

**Hors périmètre (chantier ultérieur)** : notifications vers le groupe d'info résa (`reservationNotifyWhatsappGroupJid`) pour events joueurs + events « system » des 4 étapes pipeline, via un topic NATS dédié squash-assistant. Pas traité ici.

---

## 1. Portée

**Étape A — Live refresh** :
- Fan-out SSE depuis `apps/listener` après le filtre résa allowlist.
- Proxy `apps/ui` → listener (ClusterIP), auth = ForwardAuth Authentik UI.
- Page job : `EventSource` + `router.refresh()` si `chatJid` = `rule.whatsappGroupJid`.

**Étape B — Admin dans `apps/ui` (dernière étape du plan)** :
- Persistance PG des events résa reçus.
- Config filtres par `eventType` pour le relais WhatsApp Vincent All.
- Page admin historique + cases à cocher.

**Explicitement hors périmètre** :
- WebSocket natif navigateur → listener.
- Ingress / exposition publique du listener.
- Mise à jour locale du tally depuis le payload SSE.
- Events system / topic NATS assistant.
- UI embarquée dans le pod listener (admin = `apps/ui` uniquement).

---

## 2. Architecture (vue d'ensemble)

```
huddle-bot → NATS WHATSAPP_EVENTS
                ↓
         apps/listener
           filtre allowlist + eventType résa
           → persist PG (étape B)
           → SSE broadcast (toujours, si résa allowlist)
           → relay Vincent All (si eventType activé dans config)
                ↓
         GET /events (SSE) + GET /health   :8081 ClusterIP
                ↓
         apps/ui
           /api/resa-events  → proxy SSE
           /rules/.../jobs/... → EventSource + refresh
           /listener         → historique + filtres (étape B)
```

---

## 3. Étape A — SSE

### Listener

- Même serveur HTTP que `/health` (port `HEALTH_PORT` / 8081) : ajouter `GET /events`.
- `text/event-stream`, keepalive `: ping` ~15–30 s.
- Fan-out mémoire ; erreur d'écriture → drop client.
- Échec broadcast ≠ nak JetStream.

**Payload** :
```ts
{
  eventType: string;
  chatJid: string;
  actor: { displayName: string | null; phone: string | null; jid: string };
  pollName: string | null;
  selectedOptions: string[];
  occurredAt: string;
}
```

**`onResaEvent`** (après étape B, ordre) :
1. persist (best-effort log si fail PG — ne bloque pas ack si on choisit best-effort ; **décision** : persist avant relay, échec PG → nak comme MCP pour ne pas perdre l'historique)
2. broadcast SSE
3. relay WhatsApp si `isRelayEnabled(event.eventType)`

Pour l'étape A seule (avant B) : `await relay` puis `broadcast` (comme validé initialement). L'étape B réordonne et ajoute persist + gate relay.

### UI

- `GET /api/resa-events` — pipe vers `LISTENER_INTERNAL_URL/events`.
- Client job page uniquement, debounce refresh ~1500 ms.

### Déploiement A

- Service ClusterIP listener :8081.
- Env UI : `LISTENER_INTERNAL_URL=http://squash-assistant-listener.squash-assistant.svc.cluster.local:8081`.

---

## 4. Étape B — Historique + filtres WhatsApp

### Schéma PG (`packages/db`)

**`whatsapp_resa_events`** :
- `id` uuid PK
- `event_id` text UNIQUE (idempotence JetStream redelivery)
- `event_type` text
- `occurred_at` timestamptz
- `chat_jid` text, `chat_name` text nullable
- `actor_phone`, `actor_name`, `actor_jid`
- `summary` text (même esprit que le format relais)
- `payload` jsonb
- `created_at`

**`listener_relay_settings`** (une seule ligne id=`default`, ou table clé/valeur) :
- colonnes booléennes : `poll_creation`, `poll_vote_creation`, `poll_vote_update`, `poll_vote_deletion` — défaut `true` chacune.
- Seed / migration : insert row default si absente.

### Listener

- Charge `listener_relay_settings` au démarrage + refresh périodique (même intervalle que allowlist ou dédié).
- `shouldRelayWhatsApp(eventType, settings)` en plus de allowlist/`shouldRelay` actuel.
- SSE : **pas** filtré par ces settings (l'UI live voit tout le résa allowlist).
- Persist : insert `onConflictDoNothing` sur `event_id`.

### UI `/listener`

- Gate `requireAdmin` / `isAdmin` comme le reste.
- Section filtres : 4 checkboxes + save (Server Action → update `listener_relay_settings`).
- Section historique : tableau paginé (date, type, groupe, acteur, summary), lecture DB directe (pattern `getDb()`).
- Lien nav admin.

### Règles fonctionnelles

- Documenter : le relais Vincent All respecte la config admin des types ; le live refresh UI non.

---

## 5. Critères de succès

**A**
1. Page job + event NATS/vote pour le JID de la règle → `pollTally` se rafraîchit sans clic.
2. Autre JID → pas de refresh.
3. Debounce : une rafale ≠ N refreshes.

**B**
4. Events résa apparaissent dans `/listener`.
5. Décocher `poll_vote_update` → plus de message WhatsApp pour ce type ; SSE/refresh UI continue.
6. Redelivery JetStream du même `event_id` → une seule ligne historique.

---

## 6. Ordre d'implémentation (plan)

1. SSE listener + Service k8s + proxy UI + client job
2. Tables PG + persist + settings + gate relay + page `/listener`
