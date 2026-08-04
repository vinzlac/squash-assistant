# Design — Listener NATS WhatsApp events (relais résa → Vincent All)

**Statut** : approuvé pour passage en plan d'implémentation.
**Date** : 2026-08-04
**Contexte** : huddle-bot publie les events WhatsApp sur JetStream (`stream WHATSAPP_EVENTS`, subjects `homelab.whatsapp.<jid-sanitized>` — ADR-012 huddle-bot). squash-assistant a besoin d'être notifié des events liés aux réservations (sondage / votes) pour (1) un relais lisible dans le groupe de test WhatsApp « Vincent All », puis (2) un rafraîchissement live de l'UI via WebSocket.

Références :
- huddle-bot `docs/adr/ADR-012-nats-whatsapp-events-couverture.md`
- k3s-homelab `docs/plan/plan-nats-event-bus-whatsapp.md`
- Contrat payload : huddle-bot `packages/shared/src/types/whatsapp-events.ts`

---

## 1. Portée

**MVP (phase 1) — fait dans ce projet** :
- Nouvelle app `apps/listener` dans le monorepo squash-assistant.
- Consumer JetStream durable dédié sur `WHATSAPP_EVENTS`.
- Filtrage : groupes squash allowlist (hors Vincent All) + `eventType` résa uniquement.
- Relais texte vers le groupe WhatsApp « Vincent All » via MCP huddle-bot (`send_group_message`).
- Déploiement k3s documenté côté `k3s-homelab` (Deployment + secrets), hors manifests dans ce repo (pattern PAAS).

**Phase 2 — hors MVP, architecture anticipée** :
- Même process : fan-out WebSocket vers `apps/ui` pour rafraîchir les réponses de sondage sans poll HTTP.
- Auth WS et détail d'endpoint à figer au moment de l'implémentation phase 2.

**Explicitement hors périmètre (MVP)** :
- Pas de table Postgres d'audit / historique des events (JetStream = tampon ; ack après MCP OK).
- Pas de publication NATS (listener = consumer only).
- Pas de consommation des events non-résa (`message_*`, `group_creation`, réactions absentes du bus, etc.).
- Pas de relais vers les groupes joueurs « réels » — destination unique = Vincent All.
- Pas de migration du publisher huddle-bot (prérequis ADR-012 déjà acté côté huddle-bot).

---

## 2. Architecture & flux

```
huddle-bot listener
    │ publish JetStream WHATSAPP_EVENTS
    │ subject: homelab.whatsapp.<jid-sanitized>
    ▼
NATS (k3s)
    │
    ▼
apps/listener (squash-assistant)
    │ 1. chat.jid ∈ allowlist squash (excl. Vincent All)
    │ 2. eventType ∈ poll_creation | poll_vote_*
    │ 3. format résumé texte
    │ 4. (phase 2) broadcast WS
    ▼
huddle-bot MCP → send_group_message(Vincent All)
```

- Process **séparé** de `apps/worker` (scheduler / LangGraph) : un incident NATS/MCP du listener ne tue pas les crons.
- Handler unique `onResaEvent` → fan-out `[relayWhatsApp, /* later: wsBroadcast */]` pour ne pas bloquer la phase 2.

### Pourquoi pas dans le worker ni dans huddle-bot backoffice

| Option | Décision |
|--------|----------|
| Brancher dans `apps/worker` | Rejetée — mélange jobs LangGraph et bus temps réel. |
| Étendre le consumer backoffice huddle-bot | Rejetée — couple squash-assistant à l'UI huddle-bot ; le WS UI squash n'y a pas sa place. |
| **`apps/listener` dédiée** | **Retenue.** |

---

## 3. Contrat NATS (rappel ADR-012)

- Stream : `WHATSAPP_EVENTS`
- Subject : `homelab.whatsapp.<jid-sanitized>` — **pas de type d'event dans le subject**
- Sanitisation JID : caractères hors `[a-zA-Z0-9-]` → `_` (ex. `120363…@g.us` → `120363…_g_us`)
- Type discriminant : champ payload `eventType` uniquement
- Enveloppe : `{ eventId, eventType, occurredAt, chat:{jid,name,isGroup}, actor:{phone,displayName,jid}, data:{…} }`

Le listener ne parse pas le subject pour le type ; il désérialise le JSON et lit `eventType` + `chat.jid`.

---

## 4. Config, allowlist, filtres

### Variables d'environnement

| Variable | Rôle |
|----------|------|
| `NATS_URL` | Broker (ex. `nats://nats.nats.svc.cluster.local:4222`) |
| `NATS_USER` / `NATS_PASSWORD` | User subscribe-only `whatsapp-consumers` (réutilisé) |
| `VINCENT_ALL_GROUP_JID` | Destination du relais (ex. `120363424956785709@g.us`) |
| `HUDDLE_BOT_MCP_URL` + clé API | Même pattern que `apps/worker` |

### Allowlist sources

- JIDs des **règles squash actives** (`booking_rules` où `enabled`), lus via `@squash-assistant/db`.
- **Exclure** systématiquement `VINCENT_ALL_GROUP_JID` (évite une boucle si un jour Vincent All est aussi une règle enabled / si un event y est publié).
- Rechargement périodique simple de l'allowlist (intervalle raisonnable, ex. 60s) — pas de recreate du consumer NATS à chaque changement de règle.

### Subscription JetStream

- Durable consumer dédié : `squash-assistant-listener` (indépendant de `backoffice-consumer`).
- `filter_subject` : `homelab.whatsapp.>` (même pattern que le backoffice huddle-bot).
- Filtrage JIDs **en code** après réception (l'allowlist évolue sans toucher NATS).

### Filtre métier (relais Vincent All)

Uniquement :

| `eventType` | Sens |
|-------------|------|
| `poll_creation` | Sondage créé via le bot |
| `poll_vote_creation` | Vote ajouté |
| `poll_vote_update` | Vote modifié |
| `poll_vote_deletion` | Vote retiré |

Tout autre event (ou chat hors allowlist) → **ack immédiat**, pas de MCP.

---

## 5. Relais WhatsApp (format)

Envoi via MCP huddle-bot `send_group_message` vers `VINCENT_ALL_GROUP_JID`.

Texte MVP (exemple) :

```
[squash] <nom groupe source>
poll_vote_update — <actor.displayName | phone | jid>
sondage: <pollName>
options: <selectedOptions jointes>
```

Adapter le libellé selon `eventType` (`poll_creation` liste les options du sondage ; votes utilisent `selectedOptions` / `previousOptions` si utile pour un update).

Pas d'exigence de markdown riche ni de thread WhatsApp en MVP.

---

## 6. Erreurs, ack, idempotence

| Cas | Action |
|-----|--------|
| JSON invalide / schéma inattendu | log + ack (évite poison-pill infini) |
| Hors allowlist / hors eventType résa | ack |
| MCP OK | ack |
| MCP échec transient | nak + backoff (ex. 5 / 15 / 30 / 60 s, comme backoffice) |

Pas de dédup Postgres. Un retry MCP peut donc produire un double message dans Vincent All en cas d'ack perdu après envoi réussi — acceptable pour un canal de test.

---

## 7. Structure applicative (indicatif)

```
apps/listener/
  src/
    index.ts           # connect NATS, boucle consume
    config.ts
    allowlist.ts       # charge booking_rules enabled − Vincent All
    filter.ts          # eventType résa + jid allowlist
    format.ts          # résumé texte
    relay.ts           # MCP send_group_message
    onResaEvent.ts     # fan-out (relay ; plus tard WS)
```

Réutiliser / extraire le client MCP huddle-bot du worker plutôt que de le dupliquer aveuglément (détail au plan d'implémentation).

Types d'events : **types locaux** dans `apps/listener` alignés sur le JSON documenté (huddle-bot `whatsapp-events.ts` / ADR-012) — pas d'import runtime cross-repo ni de package npm partagé pour le MVP.

---

## 8. Déploiement

- Image / Deployment k3s dédié `squash-assistant-listener` (1 réplica).
- Secrets : NATS + MCP + `VINCENT_ALL_GROUP_JID` (SealedSecret, pattern existant).
- Manifestes dans `k3s-homelab`, pas dans squash-assistant.
- Consumer JetStream créé via le script / JSON consumers NATS existant (`squash-assistant-listener` sur `WHATSAPP_EVENTS`).

Prérequis ops : subjects ADR-012 déjà en place côté publisher huddle-bot (sinon le consumer wildcard fonctionne encore, mais le contrat subject-by-jid doit être celui documenté).

---

## 9. Phase 2 (WebSocket) — rappel

Après filtre résa :

1. Broadcast JSON minimal `{ eventType, chatJid, actor, pollName, selectedOptions, occurredAt }` sur un endpoint WS (ex. `/ws`).
2. `apps/ui` s'abonne et rafraîchit les vues votes / détail.
3. Auth WS minimale (réseau cluster / token interne).

Aucun code WS dans le MVP ; uniquement le point d'extension `onResaEvent`.

---

## 10. Critères de succès MVP

1. Un `poll_vote_creation` (ou update/deletion / `poll_creation`) publié pour un groupe squash allowlist apparaît comme message texte dans Vincent All.
2. Le même event pour Vincent All lui-même (ou un JID hors allowlist) ne produit **aucun** message relais.
3. Un `message_creation` sur un groupe allowlist ne produit **aucun** message relais.
4. Le worker (scheduler) continue de tourner indépendamment si le listener est down.
5. Après redémarrage du listener, les events non-ackés JetStream sont rejoués (durable consumer).
