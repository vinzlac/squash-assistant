# Phase 2 SSE live refresh + admin listener — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live refresh du `pollTally` sur la page job via SSE (proxy UI → listener), puis page admin `/listener` avec historique PG et filtres WhatsApp par `eventType`.

**Architecture:** Listener HTTP `:8081` sert `/health` + `/events` (SSE fan-out). `onResaEvent` broadcast après filtre résa. UI Route Handler `/api/resa-events` pipe le stream (auth ForwardAuth). Étape finale : tables PG + gate relay + page admin.

**Tech Stack:** Node http SSE, Next.js App Router Route Handler + EventSource, Drizzle/Postgres, Vitest.

**Spec :** `docs/superpowers/specs/2026-08-04-listener-sse-live-refresh-design.md`

## Global Constraints

- Pas d'Ingress sur le listener — ClusterIP only.
- SSE UI live = tous events résa allowlist ; relais Vincent All = filtré par `listener_relay_settings` (après Task admin).
- Échec SSE/broadcast ≠ nak JetStream. Échec persist PG (étape B) → nak (comme MCP).
- Debounce refresh job page : **1500 ms**.
- Admin page : `requireAdmin` / `isAdmin` (groupe `squash-admins`).
- `apps/listener` et `apps/ui` : tests + typecheck verts après chaque tâche touchant le package.
- Chantier « events system NATS + notif reservationNotify » : **hors plan**.

---

## File Structure

| Fichier | Statut | Rôle |
|---|---|---|
| `apps/listener/src/httpServer.ts` | Créé | Remplace health-only : `/health` + `/events` |
| `apps/listener/src/sseHub.ts` | Créé | Clients SSE + `broadcast` + `toSsePayload` |
| `apps/listener/src/health.ts` | Supprimé ou délégué | Éviter double serveur |
| `apps/listener/src/onResaEvent.ts` | Modifié | relay + broadcast (+ persist/gate plus tard) |
| `apps/listener/src/index.ts` | Modifié | Passe hub à onResaEvent |
| `kubernetes/listener-deployment.yaml` | Modifié | Ajoute Service ClusterIP |
| `kubernetes/ui-deployment.yaml` | Modifié | `LISTENER_INTERNAL_URL` |
| `.env.example` | Modifié | `LISTENER_INTERNAL_URL` |
| `apps/ui/src/app/api/resa-events/route.ts` | Créé | Proxy SSE |
| `apps/ui/src/app/rules/[id]/jobs/[jobId]/ResaEventsLive.tsx` | Créé | EventSource + debounce refresh |
| `apps/ui/src/app/rules/[id]/jobs/[jobId]/page.tsx` | Modifié | Monte ResaEventsLive |
| `packages/db/src/schema.ts` | Modifié | `whatsapp_resa_events` + `listener_relay_settings` |
| `packages/db/src/migrations/…` | Généré | Migration |
| `apps/listener/src/persist.ts` | Créé | Insert event |
| `apps/listener/src/relaySettings.ts` | Créé | Load settings + `isRelayTypeEnabled` |
| `apps/ui/src/app/listener/page.tsx` | Créé | Historique + filtres |
| `apps/ui/src/lib/listenerAdmin.ts` | Créé | Queries/actions data |
| `docs/spec/regles-fonctionnelles.md` | Modifié | SSE + filtres |
| `docs/adr/ADR-021-….md` | Créé | SSE + admin listener |

---

### Task 1: SSE hub + HTTP server listener

**Files:**
- Create: `apps/listener/src/sseHub.ts`, `apps/listener/src/sseHub.test.ts`
- Create: `apps/listener/src/httpServer.ts`
- Modify: `apps/listener/src/health.ts` — supprimer l'usage (remplacé) ou faire réexporter `startHttpServer`
- Modify: `apps/listener/src/onResaEvent.ts`, `onResaEvent.test.ts`
- Modify: `apps/listener/src/index.ts`

**Interfaces:**
- Produces: `SsePayload`, `toSsePayload(event)`, `createSseHub()` → `{ addClient, broadcast, clientCount }`
- Produces: `startHttpServer(port, hub): Server`
- Modifies: `OnResaEventDeps` avec `broadcast?: (event: WhatsAppEvent) => void`

- [ ] **Step 1: Tests `toSsePayload` + hub broadcast**

```ts
// sseHub.test.ts — vérifier toSsePayload pour PollVoteCreation et PollCreation ;
// hub.broadcast appelle write sur chaque client mock ; client en erreur retiré.
```

- [ ] **Step 2: Implémenter `sseHub.ts`**

```ts
export interface SsePayload {
  eventType: string;
  chatJid: string;
  actor: { displayName: string | null; phone: string | null; jid: string };
  pollName: string | null;
  selectedOptions: string[];
  occurredAt: string;
}

export function toSsePayload(event: WhatsAppEvent): SsePayload { /* … */ }

export function createSseHub() {
  const clients = new Set<{ write: (chunk: string) => void; end?: () => void }>();
  return {
    addClient(client: { write: (chunk: string) => void }) {
      clients.add(client);
      return () => clients.delete(client);
    },
    broadcast(payload: SsePayload) {
      const chunk = `data: ${JSON.stringify(payload)}\n\n`;
      for (const c of [...clients]) {
        try { c.write(chunk); } catch { clients.delete(c); }
      }
    },
    get clientCount() { return clients.size; },
  };
}
```

- [ ] **Step 3: `httpServer.ts`** — `/health` + `/events` (headers SSE, `addClient`, ping interval 20s, cleanup on close)

- [ ] **Step 4: `onResaEvent`** — `await relay` puis `broadcast?.(event)` (best-effort try/catch log)

- [ ] **Step 5: `index.ts`** — `const hub = createSseHub(); startHttpServer(env.healthPort, hub);` passer `broadcast: (e) => hub.broadcast(toSsePayload(e))`

- [ ] **Step 6: Tests listener PASS + typecheck**

- [ ] **Step 7: Commit** `feat(listener): SSE hub /events + fan-out onResaEvent`

---

### Task 2: Service k8s listener + env UI

**Files:**
- Modify: `kubernetes/listener-deployment.yaml` — ajouter Service
- Modify: `kubernetes/ui-deployment.yaml` — env `LISTENER_INTERNAL_URL`
- Modify: `.env.example`

- [ ] **Step 1: Service**

```yaml
---
apiVersion: v1
kind: Service
metadata:
  name: squash-assistant-listener
  namespace: squash-assistant
spec:
  type: ClusterIP
  selector:
    app: squash-assistant-listener
  ports:
    - port: 8081
      targetPort: 8081
```

- [ ] **Step 2: UI env**

```yaml
- name: LISTENER_INTERNAL_URL
  value: "http://squash-assistant-listener.squash-assistant.svc.cluster.local:8081"
```

- [ ] **Step 3: `.env.example`** — documenter `LISTENER_INTERNAL_URL=http://localhost:8081` (dev)

- [ ] **Step 4: Commit** `chore(k8s): Service listener + LISTENER_INTERNAL_URL pour UI`

---

### Task 3: Proxy UI `/api/resa-events`

**Files:**
- Create: `apps/ui/src/app/api/resa-events/route.ts`

- [ ] **Step 1: Route Handler (Node runtime)**

```ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const base = process.env.LISTENER_INTERNAL_URL;
  if (!base) {
    return new Response("LISTENER_INTERNAL_URL manquant", { status: 500 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${base.replace(/\/$/, "")}/events`, {
      headers: { Accept: "text/event-stream" },
      cache: "no-store",
    });
  } catch {
    return new Response("listener injoignable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response("listener erreur", { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 2: typecheck UI**

- [ ] **Step 3: Commit** `feat(ui): proxy SSE /api/resa-events vers listener`

---

### Task 4: Client live refresh page job

**Files:**
- Create: `apps/ui/src/app/rules/[id]/jobs/[jobId]/ResaEventsLive.tsx`
- Modify: `apps/ui/src/app/rules/[id]/jobs/[jobId]/page.tsx`

- [ ] **Step 1: Composant client**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const DEBOUNCE_MS = 1500;

export function ResaEventsLive({ chatJid }: { chatJid: string }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/resa-events");
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as { chatJid?: string };
        if (data.chatJid !== chatJid) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => router.refresh(), DEBOUNCE_MS);
      } catch { /* ignore */ }
    };
    return () => {
      es.close();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [chatJid, router]);

  return null;
}
```

- [ ] **Step 2: Monter dans `page.tsx`** — `<ResaEventsLive chatJid={rule.whatsappGroupJid} />`

- [ ] **Step 3: Commit** `feat(ui): live refresh pollTally via SSE sur page job`

---

### Task 5: Docs étape A + smoke checklist

**Files:**
- Modify: `docs/spec/regles-fonctionnelles.md` — live refresh page job
- Create: `docs/adr/ADR-021-sse-live-refresh-et-admin-listener.md` (peut couvrir A+B en une ADR, section B « à venir dans la même PR/plan »)

- [ ] **Step 1: Règles + ADR (partie SSE)**

- [ ] **Step 2: Commit** `docs: live refresh SSE page job (ADR-021)`

---

### Task 6: Schéma PG events + settings

**Files:**
- Modify: `packages/db/src/schema.ts`
- Generate migration via `npm run db:generate`

**Interfaces:**
- `whatsappResaEvents`, `listenerRelaySettings` (id text PK `'default'`, 4 booleans default true)

- [ ] **Step 1: Tables dans schema.ts**

```ts
export const whatsappResaEvents = pgTable("whatsapp_resa_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: text("event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  chatJid: text("chat_jid").notNull(),
  chatName: text("chat_name"),
  actorPhone: text("actor_phone"),
  actorName: text("actor_name"),
  actorJid: text("actor_jid").notNull(),
  summary: text("summary").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const listenerRelaySettings = pgTable("listener_relay_settings", {
  id: text("id").primaryKey().default("default"),
  pollCreation: boolean("poll_creation").notNull().default(true),
  pollVoteCreation: boolean("poll_vote_creation").notNull().default(true),
  pollVoteUpdate: boolean("poll_vote_update").notNull().default(true),
  pollVoteDeletion: boolean("poll_vote_deletion").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdateFn(() => new Date()),
});
```

- [ ] **Step 2: `npm run db:generate`** + seed row default dans migration SQL custom ou `migrate` + upsert au démarrage listener

Préférer **upsert au démarrage listener** `INSERT … ON CONFLICT DO NOTHING` pour la row `default` (évite seed fragile).

- [ ] **Step 3: Commit** `feat(db): whatsapp_resa_events + listener_relay_settings`

---

### Task 7: Persist + gate relay dans listener

**Files:**
- Create: `apps/listener/src/persist.ts`, `persist.test.ts` (mock db)
- Create: `apps/listener/src/relaySettings.ts`, `relaySettings.test.ts`
- Modify: `onResaEvent.ts`, `index.ts`, `handleMessage` path (ordre)

**Ordre `onResaEvent` :**
1. `await persist(event)` — throw → remonte → nak
2. `broadcast` best-effort
3. `if (isRelayTypeEnabled(settings, event.eventType)) await relay(event)`

- [ ] **Step 1: Tests `isRelayTypeEnabled` + persist onConflict**

- [ ] **Step 2: Implémenter + refresh settings avec allowlist interval**

- [ ] **Step 3: Tests PASS**

- [ ] **Step 4: Commit** `feat(listener): persist events + filtres relay WhatsApp`

---

### Task 8: Page admin `/listener`

**Files:**
- Create: `apps/ui/src/lib/listenerAdmin.ts`
- Create: `apps/ui/src/app/listener/page.tsx`
- Modify: `apps/ui/src/app/actions.ts` — `updateListenerRelaySettingsAction`
- Modify: `apps/ui/src/app/page.tsx` — lien admin « Listener » si `admin`

- [ ] **Step 1: Queries** — `listResaEvents({ limit, offset })`, `getRelaySettings()`, `updateRelaySettings(partial)`

- [ ] **Step 2: Page** — tableau + form checkboxes (admin only pour mutation ; viewers lecture historique OK ou admin-only page entière — **décision : page entière `isAdmin` sinon message lecture refusée**, cohérent settings)

- [ ] **Step 3: Action** `requireAdmin` + update + `revalidatePath('/listener')`

- [ ] **Step 4: Commit** `feat(ui): page /listener historique + filtres WhatsApp`

---

### Task 9: Docs étape B + critères succès

**Files:**
- Modify: `docs/spec/regles-fonctionnelles.md`
- Modify: `docs/adr/ADR-021-….md` — compléter section admin
- Modify: design spec si écart

- [ ] **Step 1: Documenter filtres + historique**

- [ ] **Step 2: Commit** `docs: admin listener historique et filtres relay`

---

## Spec coverage

| Exigence | Task |
|---|---|
| SSE `/events` + fan-out | 1 |
| Service + LISTENER_INTERNAL_URL | 2 |
| Proxy UI | 3 |
| Job EventSource + debounce refresh | 4 |
| Persist + settings + gate WhatsApp | 6–7 |
| Page `/listener` | 8 |
| Docs | 5, 9 |
| Events system NATS | hors plan |
