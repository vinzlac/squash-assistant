# Design — Phase 2 : live refresh des votes (SSE via UI)

**Statut** : approuvé pour passage en plan d'implémentation.
**Date** : 2026-08-04
**Contexte** : suite au MVP listener NATS (`docs/superpowers/specs/2026-08-04-whatsapp-events-listener-design.md`, ADR-020). Le relais Vincent All est en prod. Phase 2 : rafraîchir l'aperçu des réponses (`pollTally`) sur la page job sans poll HTTP manuel.

**Hors périmètre (chantier suivant, déjà évoqué)** : notifications WhatsApp vers le groupe d'info résa (`reservationNotifyWhatsappGroupJid`) pour events joueurs + events « system » des 4 étapes pipeline, via un stream/topic NATS dédié squash-assistant. Pas traité ici.

---

## 1. Portée

**Fait dans ce projet** :
- Fan-out SSE depuis `apps/listener` après le même filtre résa que le relais Vincent All.
- Proxy authentifié `apps/ui` → listener (ClusterIP).
- Client sur la page job uniquement : `EventSource` + `router.refresh()` si `chatJid` correspond à la règle.

**Explicitement hors périmètre** :
- WebSocket natif navigateur → listener (Next App Router ne proxy pas bien les upgrades WS).
- Ingress / exposition publique du listener.
- Mise à jour locale du tally depuis le payload (source de vérité = `getPollTally` MCP).
- Events system / nouveau topic NATS assistant.
- Changement du comportement du relais Vincent All.

---

## 2. Architecture

```
huddle-bot → NATS WHATSAPP_EVENTS
                ↓
         apps/listener
           onResaEvent → relay Vincent All
                      → broadcast SSE (mémoire)
                ↓
         GET /events (text/event-stream, ClusterIP :8081)
                ↓
         apps/ui  GET /api/resa-events
           ForwardAuth Authentik (Ingress UI existant)
           proxy stream → LISTENER_INTERNAL_URL/events
                ↓
         Job page EventSource
           chatJid === rule.whatsappGroupJid
           → debounce 1–2 s → router.refresh()
           → getPollTally rechargé
```

Auth : aucune clé WS dédiée — l'appel browser → `/api/resa-events` passe par le même ForwardAuth Traefik/Authentik que le reste de l'UI.

---

## 3. Listener

### Endpoint

- `GET /events` — `Content-Type: text/event-stream`, `Cache-Control: no-cache`, connexion longue.
- Keepalive commentaire SSE (`: ping\n\n`) toutes les ~15–30 s.
- Pas d'auth applicative sur cet endpoint (réseau cluster only) ; le garde-fou est l'absence d'Ingress + le proxy UI.

### Fan-out

- Set/liste de `WritableStreamDefaultWriter` / réponses HTTP Node en mémoire.
- `broadcast(payload)` écrit `data: ${JSON.stringify(payload)}\n\n` à chaque client ; erreur d'écriture → retirer le client.
- Échec broadcast **ne provoque pas** de nak JetStream (indépendant du relay MCP).

### Payload

```ts
{
  eventType: string;       // poll_creation | poll_vote_*
  chatJid: string;
  actor: { displayName: string | null; phone: string | null; jid: string };
  pollName: string | null; // null pour poll_creation → utiliser data.name côté formatage payload
  selectedOptions: string[];
  occurredAt: string;
}
```

Construit depuis le `WhatsAppEvent` déjà filtré dans `onResaEvent`.

### `onResaEvent`

```ts
await deps.relay(event);
deps.broadcast?.(toSsePayload(event)); // sync, best-effort
```

---

## 4. UI

### Proxy

- Route Handler `apps/ui/src/app/api/resa-events/route.ts` (runtime Node).
- `LISTENER_INTERNAL_URL` (ex. `http://squash-assistant-listener.squash-assistant.svc.cluster.local:8081`).
- `fetch(`${LISTENER_INTERNAL_URL}/events`)` puis pipe le body vers la `Response` SSE.
- Si listener injoignable → 502 JSON/text court.

### Client job page

- Composant client monté depuis `jobs/[jobId]/page.tsx`, props : `chatJid` (= `rule.whatsappGroupJid`).
- `EventSource('/api/resa-events')`.
- Sur message : parse JSON ; si `event.chatJid === chatJid` → debounce (ex. 1500 ms) → `router.refresh()`.
- Cleanup `EventSource.close()` au unmount.
- Pas de SSE sur les autres pages.

---

## 5. Déploiement

- Service ClusterIP `squash-assistant-listener` port 8081 (si absent).
- Env UI : `LISTENER_INTERNAL_URL=http://squash-assistant-listener.squash-assistant.svc.cluster.local:8081`.
- Listener : `/events` sur le même port que `/health` (8081).
- Pas de nouveau secret.

---

## 6. Critères de succès

1. Page job ouverte + vote (ou event synthétique NATS) pour le `whatsappGroupJid` de la règle → `pollTally` se met à jour sans clic « rafraîchir ».
2. Event pour un **autre** groupe → pas de refresh de cette page job.
3. Listener down → `/api/resa-events` échoue proprement ; le reste de l'UI fonctionne ; le relais Vincent All et le worker inchangés quand le listener est up.
4. Rafale de votes → un seul refresh par fenêtre de debounce (pas une cascade de RSC).
