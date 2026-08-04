# Listener NATS WhatsApp events (relais Vincent All) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nouvelle app `apps/listener` qui consomme JetStream `WHATSAPP_EVENTS`, filtre les events résa des groupes squash (hors Vincent All), et relaie un résumé texte dans le groupe WhatsApp « Vincent All » via MCP huddle-bot.

**Architecture:** Process Node séparé du worker. Consumer durable `squash-assistant-listener` (`filter_subject: homelab.whatsapp.>`). Filtrage applicatif : allowlist JIDs depuis `booking_rules` enabled (excl. `VINCENT_ALL_GROUP_JID`) + `eventType ∈ poll_creation | poll_vote_*`. Fan-out via `onResaEvent` (MVP = relay MCP ; phase 2 = WebSocket). Types locaux alignés sur ADR-012 huddle-bot (pas d’import cross-repo).

**Tech Stack:** TypeScript, Node ≥20, `@nats-io/transport-node` + `@nats-io/jetstream`, `@modelcontextprotocol/sdk`, Drizzle/`@squash-assistant/db`, Vitest.

**Spec :** `docs/superpowers/specs/2026-08-04-whatsapp-events-listener-design.md`

## Global Constraints

- Subject NATS = `homelab.whatsapp.<jid-sanitized>` uniquement — le type d’event est **uniquement** dans le payload `eventType` (ADR-012 huddle-bot).
- Pas de table Postgres d’audit des events.
- Destination relais unique = `VINCENT_ALL_GROUP_JID` ; jamais de relais vers un JID de l’allowlist.
- MCP tool réel = `send_message` (jid + text) — pas `send_group_message` (n’existe pas côté client worker actuel).
- Types events = locaux dans `apps/listener` (copie du contrat JSON), pas d’import `@huddle-bot/*`.
- Manifests Deployment dans **ce** repo (`kubernetes/`) ; consumer JetStream JSON dans **k3s-homelab** (`kubernetes/nats/consumers/`).
- Image GHCR séparée : `ghcr.io/vinzlac/squash-assistant-listener`.
- `apps/listener` : `npm test` (vitest) et `npx tsc -p tsconfig.build.json` doivent rester verts après chaque tâche touchant ce package.
- Phase 2 WebSocket : **aucun code** dans ce plan — seulement le hook `onResaEvent` prêt à étendre.

---

## File Structure

| Fichier | Statut | Rôle |
|---|---|---|
| `apps/listener/package.json` | Créé | Package `@squash-assistant/listener` |
| `apps/listener/tsconfig.json` | Créé | Strict NodeNext |
| `apps/listener/tsconfig.build.json` | Créé | Build `src` → `dist` (exclure `*.test.ts`) |
| `apps/listener/vitest.config.ts` | Créé | Tests unitaires |
| `apps/listener/Dockerfile` | Créé | Image multi-stage (comme worker) |
| `apps/listener/src/whatsappEvents.ts` | Créé | Types + sanitize + `isResaEventType` |
| `apps/listener/src/filter.ts` | Créé | `shouldRelay(event, allowlist, vincentAllJid)` |
| `apps/listener/src/format.ts` | Créé | `formatRelayMessage(event)` |
| `apps/listener/src/allowlist.ts` | Créé | Charge JIDs depuis `booking_rules` |
| `apps/listener/src/config.ts` | Créé | `loadEnv()` |
| `apps/listener/src/mcp/client.ts` | Créé | Client MCP générique (copie worker) |
| `apps/listener/src/mcp/huddleBot.ts` | Créé | `connectHuddleBot` + `sendMessage` |
| `apps/listener/src/relay.ts` | Créé | Envoie le résumé vers Vincent All |
| `apps/listener/src/onResaEvent.ts` | Créé | Fan-out (relay ; plus tard WS) |
| `apps/listener/src/handleMessage.ts` | Créé | Parse JSON, filtre, ack/nak |
| `apps/listener/src/index.ts` | Créé | Boucle JetStream + refresh allowlist + `/health` |
| `apps/listener/src/*.test.ts` | Créé | Tests unitaires par module |
| `package.json` (racine) | Modifié | Scripts `listener:*` |
| `.env.example` | Modifié | Vars NATS + Vincent All |
| `.github/workflows/build-push-listener.yml` | Créé | Miroir UI/worker |
| `kubernetes/listener-deployment.yaml` | Créé | Deployment 1 réplica |
| `kubernetes/squash-assistant-nats.sealed.yaml` | Créé | Secrets NATS + VINCENT_ALL (scellé) |
| `docs/adr/ADR-020-listener-nats-whatsapp-events.md` | Créé | Décision app dédiée |
| `docs/spec/regles-fonctionnelles.md` | Modifié | Comportement relais |
| `../k3s-homelab/kubernetes/nats/consumers/squash-assistant-listener.json` | Créé (autre repo) | Consumer durable JetStream |

---

### Task 1: Scaffold `apps/listener`

**Files:**
- Create: `apps/listener/package.json`
- Create: `apps/listener/tsconfig.json`
- Create: `apps/listener/tsconfig.build.json`
- Create: `apps/listener/vitest.config.ts`
- Create: `apps/listener/src/config.ts`
- Create: `apps/listener/src/config.test.ts`
- Modify: `package.json` (racine) — scripts `listener:*`
- Modify: `.env.example`

**Interfaces:**
- Produces: `loadEnv(): ListenerEnv` avec champs
  `{ natsUrl, natsUser, natsPassword, vincentAllGroupJid, huddleBotMcpUrl, huddleBotMcpApiKey, databaseUrl, allowlistRefreshMs, healthPort }`

- [ ] **Step 1: Créer `apps/listener/package.json`**

```json
{
  "name": "@squash-assistant/listener",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@nats-io/jetstream": "^3.4.0",
    "@nats-io/nats-core": "^3.4.0",
    "@nats-io/transport-node": "^3.4.0",
    "@squash-assistant/db": "*",
    "drizzle-orm": "^0.45.2"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: Créer les tsconfig + vitest**

`tsconfig.json` — même base que worker (`target ES2022`, `module NodeNext`, `strict`, `rootDir src`, `outDir dist`).

`tsconfig.build.json` :

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts"]
}
```

`vitest.config.ts` :

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 3: Écrire le test `config.test.ts` (failing)**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "./config.js";

const REQUIRED = [
  "NATS_URL",
  "NATS_USER",
  "NATS_PASSWORD",
  "VINCENT_ALL_GROUP_JID",
  "HUDDLE_BOT_MCP_URL",
  "HUDDLE_BOT_MCP_API_KEY",
  "DATABASE_URL",
] as const;

describe("loadEnv", () => {
  afterEach(() => {
    for (const k of REQUIRED) delete process.env[k];
    delete process.env.ALLOWLIST_REFRESH_MS;
    delete process.env.HEALTH_PORT;
  });

  it("charge les variables requises", () => {
    process.env.NATS_URL = "nats://nats:4222";
    process.env.NATS_USER = "whatsapp-consumers";
    process.env.NATS_PASSWORD = "secret";
    process.env.VINCENT_ALL_GROUP_JID = "120363424956785709@g.us";
    process.env.HUDDLE_BOT_MCP_URL = "https://huddle-bot.example/api/mcp";
    process.env.HUDDLE_BOT_MCP_API_KEY = "sk_live_x";
    process.env.DATABASE_URL = "postgres://u:p@localhost/db";
    const env = loadEnv();
    expect(env.vincentAllGroupJid).toBe("120363424956785709@g.us");
    expect(env.allowlistRefreshMs).toBe(60_000);
    expect(env.healthPort).toBe(8081);
  });

  it("échoue si une variable manque", () => {
    expect(() => loadEnv()).toThrow(/NATS_URL/);
  });
});
```

- [ ] **Step 4: Run test — expect FAIL**

Run: `npm test -w @squash-assistant/listener`
Expected: FAIL (module `config` absent)

- [ ] **Step 5: Implémenter `config.ts`**

```ts
export interface ListenerEnv {
  natsUrl: string;
  natsUser: string;
  natsPassword: string;
  vincentAllGroupJid: string;
  huddleBotMcpUrl: string;
  huddleBotMcpApiKey: string;
  databaseUrl: string;
  allowlistRefreshMs: number;
  healthPort: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante : ${name}`);
  return value;
}

export function loadEnv(): ListenerEnv {
  return {
    natsUrl: requireEnv("NATS_URL"),
    natsUser: requireEnv("NATS_USER"),
    natsPassword: requireEnv("NATS_PASSWORD"),
    vincentAllGroupJid: requireEnv("VINCENT_ALL_GROUP_JID"),
    huddleBotMcpUrl: requireEnv("HUDDLE_BOT_MCP_URL"),
    huddleBotMcpApiKey: requireEnv("HUDDLE_BOT_MCP_API_KEY"),
    databaseUrl: requireEnv("DATABASE_URL"),
    allowlistRefreshMs: Number(process.env.ALLOWLIST_REFRESH_MS ?? "60000"),
    healthPort: Number(process.env.HEALTH_PORT ?? "8081"),
  };
}
```

- [ ] **Step 6: Run test — expect PASS**

Run: `npm install` (racine, pour lier le workspace) puis `npm test -w @squash-assistant/listener`

- [ ] **Step 7: Brancher scripts racine + `.env.example`**

Dans `package.json` racine, ajouter :

```json
"listener:dev": "npm run db:build && npm run dev -w @squash-assistant/listener",
"listener:build": "npm run db:build && npm run build -w @squash-assistant/listener",
"listener:typecheck": "npm run typecheck -w @squash-assistant/listener",
"listener:test": "npm run test -w @squash-assistant/listener"
```

Ajouter à `.env.example` :

```
# apps/listener — bus WhatsApp (NATS JetStream WHATSAPP_EVENTS)
NATS_URL=nats://nats.nats.svc.cluster.local:4222
NATS_USER=whatsapp-consumers
NATS_PASSWORD=
VINCENT_ALL_GROUP_JID=120363424956785709@g.us
ALLOWLIST_REFRESH_MS=60000
HEALTH_PORT=8081
```

- [ ] **Step 8: Commit**

```bash
git add apps/listener package.json package-lock.json .env.example
git commit -m "$(cat <<'EOF'
chore(listener): scaffold apps/listener + config env

EOF
)"
```

---

### Task 2: Types WhatsApp events + sanitize + filtre type résa

**Files:**
- Create: `apps/listener/src/whatsappEvents.ts`
- Create: `apps/listener/src/whatsappEvents.test.ts`

**Interfaces:**
- Produces:
  - `WhatsAppEventType` (enum string)
  - `WhatsAppEvent` (union)
  - `sanitizeWhatsAppJidForSubject(jid: string): string`
  - `whatsAppEventSubject(chatJid: string): string`
  - `isResaEventType(t: string): t is ResaEventType`
  - `RESA_EVENT_TYPES` = `poll_creation | poll_vote_creation | poll_vote_update | poll_vote_deletion`
  - `parseWhatsAppEvent(raw: unknown): WhatsAppEvent` (throw si invalide)

- [ ] **Step 1: Écrire les tests**

```ts
import { describe, expect, it } from "vitest";
import {
  isResaEventType,
  parseWhatsAppEvent,
  sanitizeWhatsAppJidForSubject,
  whatsAppEventSubject,
  WhatsAppEventType,
} from "./whatsappEvents.js";

describe("sanitizeWhatsAppJidForSubject", () => {
  it("remplace @ et .", () => {
    expect(sanitizeWhatsAppJidForSubject("120363@g.us")).toBe("120363_g_us");
  });
});

describe("whatsAppEventSubject", () => {
  it("préfixe homelab.whatsapp.", () => {
    expect(whatsAppEventSubject("120363@g.us")).toBe("homelab.whatsapp.120363_g_us");
  });
});

describe("isResaEventType", () => {
  it("accepte poll_* résa", () => {
    expect(isResaEventType(WhatsAppEventType.PollVoteCreation)).toBe(true);
    expect(isResaEventType(WhatsAppEventType.MessageCreation)).toBe(false);
  });
});

describe("parseWhatsAppEvent", () => {
  it("parse un poll_vote_creation", () => {
    const event = parseWhatsAppEvent({
      eventId: "e1",
      eventType: "poll_vote_creation",
      occurredAt: "2026-08-04T08:00:00.000Z",
      chat: { jid: "120363@g.us", name: "Squash", isGroup: true },
      actor: { phone: "33600", displayName: "Alice", jid: "33600@s.whatsapp.net" },
      data: {
        pollWhatsappMessageId: "m1",
        pollName: "Qui joue ?",
        selectedOptions: ["18H45"],
        previousOptions: [],
      },
    });
    expect(event.eventType).toBe("poll_vote_creation");
  });

  it("rejette un payload sans eventType", () => {
    expect(() => parseWhatsAppEvent({ eventId: "x" })).toThrow();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -w @squash-assistant/listener -- src/whatsappEvents.test.ts`

- [ ] **Step 3: Implémenter `whatsappEvents.ts`**

Aligner sur huddle-bot `packages/shared/src/types/whatsapp-events.ts` (enum + unions `PollCreation` / `PollVote*` / autres pour le parse). Pour `parseWhatsAppEvent` : validation minimale (`eventId`, `eventType`, `occurredAt`, `chat.jid`, `actor`, `data` présents ; `eventType` ∈ enum). Pas besoin de zod pour le MVP.

`isResaEventType` :

```ts
const RESA = new Set([
  WhatsAppEventType.PollCreation,
  WhatsAppEventType.PollVoteCreation,
  WhatsAppEventType.PollVoteUpdate,
  WhatsAppEventType.PollVoteDeletion,
]);
export function isResaEventType(t: string): boolean {
  return RESA.has(t as WhatsAppEventType);
}
```

Sanitize :

```ts
export function sanitizeWhatsAppJidForSubject(jid: string): string {
  return jid.replace(/[^a-zA-Z0-9-]/g, "_");
}
export function whatsAppEventSubject(chatJid: string): string {
  return `homelab.whatsapp.${sanitizeWhatsAppJidForSubject(chatJid)}`;
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/listener/src/whatsappEvents.ts apps/listener/src/whatsappEvents.test.ts
git commit -m "$(cat <<'EOF'
feat(listener): types WhatsApp events + sanitize subject ADR-012

EOF
)"
```

---

### Task 3: `shouldRelay` (allowlist + type)

**Files:**
- Create: `apps/listener/src/filter.ts`
- Create: `apps/listener/src/filter.test.ts`

**Interfaces:**
- Consumes: `WhatsAppEvent`, `isResaEventType`
- Produces: `shouldRelay(event: WhatsAppEvent, allowlist: ReadonlySet<string>, vincentAllGroupJid: string): boolean`

- [ ] **Step 1: Tests**

```ts
import { describe, expect, it } from "vitest";
import { shouldRelay } from "./filter.js";
import { WhatsAppEventType, type WhatsAppEvent } from "./whatsappEvents.js";

const vincent = "120363424956785709@g.us";
const squash = "120363041739962569@g.us";

function base(over: Partial<WhatsAppEvent> & { eventType: WhatsAppEventType; chatJid?: string }): WhatsAppEvent {
  return {
    eventId: "e1",
    eventType: over.eventType,
    occurredAt: "2026-08-04T08:00:00.000Z",
    chat: { jid: over.chatJid ?? squash, name: "G", isGroup: true },
    actor: { phone: null, displayName: "A", jid: "a@s.whatsapp.net" },
    data: over.data ?? {
      pollWhatsappMessageId: "m",
      pollName: "Qui ?",
      selectedOptions: ["18H45"],
      previousOptions: [],
    },
  } as WhatsAppEvent;
}

describe("shouldRelay", () => {
  const allow = new Set([squash]);

  it("relaye poll_vote sur groupe allowlist", () => {
    expect(shouldRelay(base({ eventType: WhatsAppEventType.PollVoteCreation }), allow, vincent)).toBe(true);
  });

  it("ignore message_creation même allowlist", () => {
    expect(
      shouldRelay(
        base({
          eventType: WhatsAppEventType.MessageCreation,
          data: { whatsappMessageId: "m", content: "hi" },
        } as never),
        allow,
        vincent,
      ),
    ).toBe(false);
  });

  it("ignore Vincent All même si dans allowlist par erreur", () => {
    expect(
      shouldRelay(
        base({ eventType: WhatsAppEventType.PollVoteCreation, chatJid: vincent }),
        new Set([vincent, squash]),
        vincent,
      ),
    ).toBe(false);
  });

  it("ignore JID hors allowlist", () => {
    expect(
      shouldRelay(base({ eventType: WhatsAppEventType.PollVoteCreation, chatJid: "other@g.us" }), allow, vincent),
    ).toBe(false);
  });
});
```

Ajuster le helper `base` si TypeScript se plaint sur les unions — l’important est de couvrir les 4 cas.

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implémenter**

```ts
import { isResaEventType, type WhatsAppEvent } from "./whatsappEvents.js";

export function shouldRelay(
  event: WhatsAppEvent,
  allowlist: ReadonlySet<string>,
  vincentAllGroupJid: string,
): boolean {
  if (event.chat.jid === vincentAllGroupJid) return false;
  if (!allowlist.has(event.chat.jid)) return false;
  return isResaEventType(event.eventType);
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/listener/src/filter.ts apps/listener/src/filter.test.ts
git commit -m "$(cat <<'EOF'
feat(listener): filtre shouldRelay allowlist + eventType résa

EOF
)"
```

---

### Task 4: Format du message relais

**Files:**
- Create: `apps/listener/src/format.ts`
- Create: `apps/listener/src/format.test.ts`

**Interfaces:**
- Produces: `formatRelayMessage(event: WhatsAppEvent): string`

- [ ] **Step 1: Tests**

```ts
import { describe, expect, it } from "vitest";
import { formatRelayMessage } from "./format.js";
import { WhatsAppEventType } from "./whatsappEvents.js";

describe("formatRelayMessage", () => {
  it("formate un vote", () => {
    const text = formatRelayMessage({
      eventId: "e1",
      eventType: WhatsAppEventType.PollVoteUpdate,
      occurredAt: "2026-08-04T08:00:00.000Z",
      chat: { jid: "120363@g.us", name: "Squash Académie", isGroup: true },
      actor: { phone: "33600", displayName: "Alice", jid: "33600@s.whatsapp.net" },
      data: {
        pollWhatsappMessageId: "m1",
        pollName: "Qui joue mardi ?",
        selectedOptions: ["19H30"],
        previousOptions: ["18H45"],
      },
    });
    expect(text).toContain("[squash] Squash Académie");
    expect(text).toContain("poll_vote_update — Alice");
    expect(text).toContain("sondage: Qui joue mardi ?");
    expect(text).toContain("options: 19H30");
  });

  it("formate une création de sondage", () => {
    const text = formatRelayMessage({
      eventId: "e2",
      eventType: WhatsAppEventType.PollCreation,
      occurredAt: "2026-08-04T08:00:00.000Z",
      chat: { jid: "120363@g.us", name: null, isGroup: true },
      actor: { phone: null, displayName: null, jid: "bot@s.whatsapp.net" },
      data: {
        whatsappMessageId: "m2",
        name: "Qui joue ?",
        options: ["18H45", "19H30"],
        allowMultiple: false,
      },
    });
    expect(text).toContain("[squash] 120363@g.us");
    expect(text).toContain("poll_creation");
    expect(text).toContain("options: 18H45, 19H30");
  });
});
```

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implémenter `format.ts`**

```ts
import { WhatsAppEventType, type WhatsAppEvent } from "./whatsappEvents.js";

function actorLabel(event: WhatsAppEvent): string {
  return event.actor.displayName ?? event.actor.phone ?? event.actor.jid;
}

function groupLabel(event: WhatsAppEvent): string {
  return event.chat.name ?? event.chat.jid;
}

export function formatRelayMessage(event: WhatsAppEvent): string {
  const header = `[squash] ${groupLabel(event)}`;
  const who = `${event.eventType} — ${actorLabel(event)}`;
  switch (event.eventType) {
    case WhatsAppEventType.PollCreation:
      return [
        header,
        who,
        `sondage: ${event.data.name}`,
        `options: ${event.data.options.join(", ") || "(aucune)"}`,
      ].join("\n");
    case WhatsAppEventType.PollVoteCreation:
    case WhatsAppEventType.PollVoteUpdate:
    case WhatsAppEventType.PollVoteDeletion:
      return [
        header,
        who,
        `sondage: ${event.data.pollName}`,
        `options: ${event.data.selectedOptions.join(", ") || "(aucune)"}`,
      ].join("\n");
    default:
      return [header, who].join("\n");
  }
}
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/listener/src/format.ts apps/listener/src/format.test.ts
git commit -m "$(cat <<'EOF'
feat(listener): formatage résumé relais WhatsApp

EOF
)"
```

---

### Task 5: Allowlist depuis `booking_rules`

**Files:**
- Create: `apps/listener/src/allowlist.ts`
- Create: `apps/listener/src/allowlist.test.ts`

**Interfaces:**
- Consumes: `Database` (`createDbClient`), table `bookingRules`
- Produces: `loadAllowlist(db: Database, vincentAllGroupJid: string): Promise<Set<string>>`

- [ ] **Step 1: Tests** (mock db minimal — pas besoin Postgres)

```ts
import { describe, expect, it, vi } from "vitest";
import { loadAllowlist } from "./allowlist.js";

describe("loadAllowlist", () => {
  it("retourne les JIDs enabled hors Vincent All", async () => {
    const vincent = "120363424956785709@g.us";
    const rows = [
      { whatsappGroupJid: "group-a@g.us" },
      { whatsappGroupJid: vincent },
      { whatsappGroupJid: "group-b@g.us" },
    ];
    const db = {
      select: () => ({
        from: () => ({
          where: async () => rows,
        }),
      }),
    };
    const set = await loadAllowlist(db as never, vincent);
    expect(set.has("group-a@g.us")).toBe(true);
    expect(set.has("group-b@g.us")).toBe(true);
    expect(set.has(vincent)).toBe(false);
  });
});
```

Si le mock ne match pas la chaîne Drizzle réelle, préférer extraire la logique pure :

```ts
export function buildAllowlist(
  jids: string[],
  vincentAllGroupJid: string,
): Set<string> {
  return new Set(jids.filter((j) => j !== vincentAllGroupJid));
}
```

et tester `buildAllowlist` ; `loadAllowlist` fait le `select` + appelle `buildAllowlist`.

- [ ] **Step 2: Implémenter**

```ts
import { eq } from "drizzle-orm";
import { bookingRules, type Database } from /* adapters */;

// createDbClient + bookingRules depuis @squash-assistant/db
import { bookingRules } from "@squash-assistant/db/schema";
import type { Database } from "@squash-assistant/db/client";

export function buildAllowlist(jids: string[], vincentAllGroupJid: string): Set<string> {
  return new Set(jids.filter((j) => j !== vincentAllGroupJid));
}

export async function loadAllowlist(
  db: Database,
  vincentAllGroupJid: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ whatsappGroupJid: bookingRules.whatsappGroupJid })
    .from(bookingRules)
    .where(eq(bookingRules.enabled, true));
  return buildAllowlist(
    rows.map((r) => r.whatsappGroupJid),
    vincentAllGroupJid,
  );
}
```

Vérifier les exports `@squash-assistant/db/schema` et `@squash-assistant/db/client` (déjà présents).

- [ ] **Step 3: Tests PASS + typecheck**

Run: `npm run db:build && npm test -w @squash-assistant/listener && npm run typecheck -w @squash-assistant/listener`

- [ ] **Step 4: Commit**

```bash
git add apps/listener/src/allowlist.ts apps/listener/src/allowlist.test.ts
git commit -m "$(cat <<'EOF'
feat(listener): allowlist JIDs depuis booking_rules enabled

EOF
)"
```

---

### Task 6: MCP huddle-bot + relay

**Files:**
- Create: `apps/listener/src/mcp/client.ts` (copie de `apps/worker/src/mcp/client.ts`)
- Create: `apps/listener/src/mcp/huddleBot.ts` (sous-ensemble : connect + sendMessage)
- Create: `apps/listener/src/relay.ts`
- Create: `apps/listener/src/relay.test.ts`
- Create: `apps/listener/src/onResaEvent.ts`
- Create: `apps/listener/src/onResaEvent.test.ts`

**Interfaces:**
- Produces:
  - `sendMessage(client, jid, text): Promise<void>`
  - `relayToVincentAll(deps, event): Promise<void>`
  - `onResaEvent(deps, event): Promise<void>` — appelle `relayToVincentAll` (point d’extension WS)

- [ ] **Step 1: Copier `mcp/client.ts` depuis worker** (identique)

- [ ] **Step 2: `mcp/huddleBot.ts`**

```ts
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callTool, connectMcpClient, type McpConnection } from "./client.js";

export function connectHuddleBot(url: string, apiKey: string): Promise<McpConnection> {
  return connectMcpClient("huddle-bot-listener", url, apiKey);
}

export function sendMessage(client: Client, jid: string, text: string): Promise<void> {
  return callTool(client, "send_message", { jid, text });
}
```

- [ ] **Step 3: Tests relay / onResaEvent avec mock**

```ts
import { describe, expect, it, vi } from "vitest";
import { relayToVincentAll } from "./relay.js";
import { onResaEvent } from "./onResaEvent.js";
import { WhatsAppEventType } from "./whatsappEvents.js";

const event = {
  eventId: "e1",
  eventType: WhatsAppEventType.PollVoteCreation,
  occurredAt: "2026-08-04T08:00:00.000Z",
  chat: { jid: "g@g.us", name: "G", isGroup: true },
  actor: { phone: null, displayName: "Bob", jid: "b@s.whatsapp.net" },
  data: {
    pollWhatsappMessageId: "m",
    pollName: "Qui ?",
    selectedOptions: ["18H45"],
    previousOptions: [],
  },
} as const;

describe("relayToVincentAll", () => {
  it("appelle sendMessage vers Vincent All", async () => {
    const sendMessage = vi.fn(async () => {});
    await relayToVincentAll(
      {
        vincentAllGroupJid: "vincent@g.us",
        sendMessage,
        client: {} as never,
      },
      event as never,
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][1]).toBe("vincent@g.us");
    expect(sendMessage.mock.calls[0][2]).toContain("poll_vote_creation");
  });
});

describe("onResaEvent", () => {
  it("délègue au relay", async () => {
    const relay = vi.fn(async () => {});
    await onResaEvent({ relay }, event as never);
    expect(relay).toHaveBeenCalledWith(event);
  });
});
```

- [ ] **Step 4: Implémenter `relay.ts` / `onResaEvent.ts`**

```ts
// relay.ts
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { formatRelayMessage } from "./format.js";
import type { WhatsAppEvent } from "./whatsappEvents.js";

export interface RelayDeps {
  client: Client;
  vincentAllGroupJid: string;
  sendMessage: (client: Client, jid: string, text: string) => Promise<void>;
}

export async function relayToVincentAll(deps: RelayDeps, event: WhatsAppEvent): Promise<void> {
  const text = formatRelayMessage(event);
  await deps.sendMessage(deps.client, deps.vincentAllGroupJid, text);
}
```

```ts
// onResaEvent.ts
import type { WhatsAppEvent } from "./whatsappEvents.js";

export interface OnResaEventDeps {
  relay: (event: WhatsAppEvent) => Promise<void>;
  // phase 2: wsBroadcast?: (event: WhatsAppEvent) => Promise<void>;
}

export async function onResaEvent(deps: OnResaEventDeps, event: WhatsAppEvent): Promise<void> {
  await deps.relay(event);
}
```

- [ ] **Step 5: Tests PASS**

- [ ] **Step 6: Commit**

```bash
git add apps/listener/src/mcp apps/listener/src/relay.ts apps/listener/src/relay.test.ts \
  apps/listener/src/onResaEvent.ts apps/listener/src/onResaEvent.test.ts
git commit -m "$(cat <<'EOF'
feat(listener): relay MCP send_message vers Vincent All

EOF
)"
```

---

### Task 7: `handleMessage` (parse, filtre, ack/nak)

**Files:**
- Create: `apps/listener/src/handleMessage.ts`
- Create: `apps/listener/src/handleMessage.test.ts`

**Interfaces:**
- Consumes: `parseWhatsAppEvent`, `shouldRelay`, `onResaEvent`
- Produces: `handleJsMessage(msg, ctx): Promise<void>`
- `BACKOFF_STEPS_MS = [5000, 15000, 30000, 60000]`

Le type `JsMsg` de `@nats-io/jetstream` expose `json()`, `ack()`, `nak(millis?)`, `info.deliveryCount`. Pour les tests, mocker une interface minimale :

```ts
export interface AckableMsg {
  data: Uint8Array | string;
  json<T>(): T;
  ack(): void;
  nak(millis?: number): void;
  info: { deliveryCount: number };
}
```

- [ ] **Step 1: Tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { handleJsMessage } from "./handleMessage.js";
import { WhatsAppEventType } from "./whatsappEvents.js";

function makeMsg(payload: unknown, deliveryCount = 1) {
  return {
    json: <T>() => payload as T,
    ack: vi.fn(),
    nak: vi.fn(),
    info: { deliveryCount },
  };
}

const squash = "group@g.us";
const vincent = "vincent@g.us";

describe("handleJsMessage", () => {
  it("ack sans relay si hors filtre", async () => {
    const onResa = vi.fn();
    const msg = makeMsg({
      eventId: "e",
      eventType: WhatsAppEventType.MessageCreation,
      occurredAt: "2026-08-04T08:00:00.000Z",
      chat: { jid: squash, name: "G", isGroup: true },
      actor: { phone: null, displayName: null, jid: "a@s.whatsapp.net" },
      data: { whatsappMessageId: "m", content: "hi" },
    });
    await handleJsMessage(msg, {
      allowlist: new Set([squash]),
      vincentAllGroupJid: vincent,
      onResaEvent: onResa,
    });
    expect(onResa).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it("ack après onResaEvent OK", async () => {
    const onResa = vi.fn(async () => {});
    const msg = makeMsg({
      eventId: "e",
      eventType: WhatsAppEventType.PollVoteCreation,
      occurredAt: "2026-08-04T08:00:00.000Z",
      chat: { jid: squash, name: "G", isGroup: true },
      actor: { phone: null, displayName: "A", jid: "a@s.whatsapp.net" },
      data: {
        pollWhatsappMessageId: "m",
        pollName: "Qui ?",
        selectedOptions: ["18H45"],
        previousOptions: [],
      },
    });
    await handleJsMessage(msg, {
      allowlist: new Set([squash]),
      vincentAllGroupJid: vincent,
      onResaEvent: onResa,
    });
    expect(onResa).toHaveBeenCalledOnce();
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it("nak avec backoff si onResaEvent échoue", async () => {
    const onResa = vi.fn(async () => {
      throw new Error("mcp down");
    });
    const msg = makeMsg(
      {
        eventId: "e",
        eventType: WhatsAppEventType.PollVoteCreation,
        occurredAt: "2026-08-04T08:00:00.000Z",
        chat: { jid: squash, name: "G", isGroup: true },
        actor: { phone: null, displayName: "A", jid: "a@s.whatsapp.net" },
        data: {
          pollWhatsappMessageId: "m",
          pollName: "Qui ?",
          selectedOptions: ["18H45"],
          previousOptions: [],
        },
      },
      2,
    );
    await handleJsMessage(msg, {
      allowlist: new Set([squash]),
      vincentAllGroupJid: vincent,
      onResaEvent: onResa,
    });
    expect(msg.nak).toHaveBeenCalledWith(15_000);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("ack poison pill JSON invalide", async () => {
    const msg = {
      json: () => {
        throw new Error("bad json");
      },
      ack: vi.fn(),
      nak: vi.fn(),
      info: { deliveryCount: 1 },
    };
    await handleJsMessage(msg, {
      allowlist: new Set(),
      vincentAllGroupJid: vincent,
      onResaEvent: vi.fn(),
    });
    expect(msg.ack).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Implémenter**

```ts
import { shouldRelay } from "./filter.js";
import { parseWhatsAppEvent, type WhatsAppEvent } from "./whatsappEvents.js";

export const BACKOFF_STEPS_MS = [5_000, 15_000, 30_000, 60_000];

export interface AckableMsg {
  json<T>(): T;
  ack(): void;
  nak(millis?: number): void;
  info: { deliveryCount: number };
}

export interface HandleContext {
  allowlist: ReadonlySet<string>;
  vincentAllGroupJid: string;
  onResaEvent: (event: WhatsAppEvent) => Promise<void>;
}

function backoffMs(deliveryCount: number): number {
  return BACKOFF_STEPS_MS[Math.min(deliveryCount - 1, BACKOFF_STEPS_MS.length - 1)];
}

export async function handleJsMessage(msg: AckableMsg, ctx: HandleContext): Promise<void> {
  let event: WhatsAppEvent;
  try {
    event = parseWhatsAppEvent(msg.json());
  } catch (err) {
    console.error("[listener] payload invalide — ack", err);
    msg.ack();
    return;
  }

  if (!shouldRelay(event, ctx.allowlist, ctx.vincentAllGroupJid)) {
    msg.ack();
    return;
  }

  try {
    await ctx.onResaEvent(event);
    msg.ack();
  } catch (err) {
    const delay = backoffMs(msg.info.deliveryCount);
    console.error(`[listener] échec traitement (tentative=${msg.info.deliveryCount}) — nak ${delay}ms`, err);
    msg.nak(delay);
  }
}
```

- [ ] **Step 3: Tests PASS**

- [ ] **Step 4: Commit**

```bash
git add apps/listener/src/handleMessage.ts apps/listener/src/handleMessage.test.ts
git commit -m "$(cat <<'EOF'
feat(listener): handleMessage ack/nak JetStream

EOF
)"
```

---

### Task 8: `index.ts` — boucle NATS + health + refresh allowlist

**Files:**
- Create: `apps/listener/src/index.ts`
- Create: `apps/listener/src/health.ts` (serveur HTTP minimal `/health`)

**Interfaces:**
- Stream `WHATSAPP_EVENTS`, consumer durable `squash-assistant-listener`
- Refresh allowlist toutes les `allowlistRefreshMs`

- [ ] **Step 1: `health.ts`**

```ts
import { createServer, type Server } from "node:http";

export function startHealthServer(port: number): Server {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port);
  return server;
}
```

- [ ] **Step 2: `index.ts`**

Structure :

```ts
import { connect } from "@nats-io/transport-node";
import { jetstream } from "@nats-io/jetstream";
import { createDbClient } from "@squash-assistant/db/client";
import { loadEnv } from "./config.js";
import { loadAllowlist } from "./allowlist.js";
import { connectHuddleBot, sendMessage } from "./mcp/huddleBot.js";
import { relayToVincentAll } from "./relay.js";
import { onResaEvent } from "./onResaEvent.js";
import { handleJsMessage } from "./handleMessage.js";
import { startHealthServer } from "./health.js";

const STREAM = "WHATSAPP_EVENTS";
const CONSUMER = "squash-assistant-listener";

async function main(): Promise<void> {
  const env = loadEnv();
  startHealthServer(env.healthPort);

  const db = createDbClient(env.databaseUrl);
  let allowlist = await loadAllowlist(db, env.vincentAllGroupJid);
  setInterval(() => {
    loadAllowlist(db, env.vincentAllGroupJid)
      .then((next) => {
        allowlist = next;
      })
      .catch((err) => console.error("[listener] refresh allowlist échoué", err));
  }, env.allowlistRefreshMs);

  const mcp = await connectHuddleBot(env.huddleBotMcpUrl, env.huddleBotMcpApiKey);
  const nc = await connect({
    servers: env.natsUrl,
    user: env.natsUser,
    pass: env.natsPassword,
  });
  const js = jetstream(nc);
  const consumer = await js.consumers.get(STREAM, CONSUMER);
  const messages = await consumer.consume();

  console.log(`[listener] abonné stream=${STREAM} consumer=${CONSUMER} allowlist=${allowlist.size}`);

  for await (const msg of messages) {
    await handleJsMessage(msg, {
      allowlist,
      vincentAllGroupJid: env.vincentAllGroupJid,
      onResaEvent: (event) =>
        onResaEvent(
          {
            relay: (e) =>
              relayToVincentAll(
                { client: mcp.client, vincentAllGroupJid: env.vincentAllGroupJid, sendMessage },
                e,
              ),
          },
          event,
        ),
    });
  }
}

main().catch((err) => {
  console.error("[listener] échec fatal", err);
  process.exit(1);
});
```

- [ ] **Step 3: Build typecheck**

Run: `npm run listener:build` (ou `npm run build -w @squash-assistant/listener` après `db:build`)

Expected: compile OK. Note : sans consumer NATS réel, `dev` échouera au `consumers.get` — normal jusqu’à Task 10.

- [ ] **Step 4: Commit**

```bash
git add apps/listener/src/index.ts apps/listener/src/health.ts
git commit -m "$(cat <<'EOF'
feat(listener): boucle JetStream + health + refresh allowlist

EOF
)"
```

---

### Task 9: Docker + CI + Deployment k8s

**Files:**
- Create: `apps/listener/Dockerfile`
- Create: `.github/workflows/build-push-listener.yml`
- Create: `kubernetes/listener-deployment.yaml`
- Create: `kubernetes/squash-assistant-nats.sealed.yaml` (après seal local)
- Create: `kubernetes/squash-assistant-vincent-all.sealed.yaml` (ou combiner dans un seul secret)

**Interfaces:**
- Image `ghcr.io/vinzlac/squash-assistant-listener:<sha>`
- GitOps met à jour `kubernetes/listener-deployment.yaml` (comme UI)

- [ ] **Step 1: Dockerfile** (miroir worker, package listener)

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/package.json
COPY apps/listener/package.json apps/listener/package.json
RUN npm ci
COPY packages/db ./packages/db
COPY apps/listener ./apps/listener
RUN npm run build -w @squash-assistant/db
RUN npm run build -w @squash-assistant/listener

FROM node:20-alpine
WORKDIR /app
ARG GIT_SHA=unknown
ARG GIT_COMMIT_DATE=unknown
ARG GIT_COMMIT_MESSAGE=unknown
ENV NODE_ENV=production
ENV GIT_SHA=$GIT_SHA
ENV GIT_COMMIT_DATE=$GIT_COMMIT_DATE
ENV GIT_COMMIT_MESSAGE=$GIT_COMMIT_MESSAGE
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/package.json
COPY apps/listener/package.json apps/listener/package.json
RUN npm ci --omit=dev
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/apps/listener/dist ./apps/listener/dist
USER node
CMD ["node", "apps/listener/dist/index.js"]
```

- [ ] **Step 2: Workflow** — copier `.github/workflows/build-push-ui.yml`, remplacer :
  - name → `Build and push (listener)`
  - paths → `apps/listener/**`, `packages/db/**`, lockfiles, ce workflow
  - Dockerfile → `./apps/listener/Dockerfile`
  - image name → `ghcr.io/${OWNER}/squash-assistant-listener` (comme UI qui force le suffixe `-ui` — vérifier le step « Nom d’image GHCR » de build-push-ui.yml et reproduire le même pattern `-listener`)
  - GitOps file → `kubernetes/listener-deployment.yaml`

Lire `build-push-ui.yml` step image name : s’il append `-ui`, faire de même avec `-listener`.

- [ ] **Step 3: `kubernetes/listener-deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: squash-assistant-listener
  namespace: squash-assistant
  labels:
    app.kubernetes.io/name: squash-assistant-listener
spec:
  replicas: 1
  selector:
    matchLabels:
      app: squash-assistant-listener
  template:
    metadata:
      labels:
        app: squash-assistant-listener
    spec:
      imagePullSecrets:
        - name: ghcr-pull
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
      containers:
        - name: listener
          image: ghcr.io/vinzlac/squash-assistant-listener:main
          imagePullPolicy: Always
          ports:
            - containerPort: 8081
          env:
            - name: HUDDLE_BOT_MCP_URL
              value: "https://huddle-bot.code-advisors.site/api/mcp"
            - name: NATS_URL
              value: "nats://nats.nats.svc.cluster.local:4222"
            - name: HEALTH_PORT
              value: "8081"
          envFrom:
            - secretRef:
                name: squash-assistant-huddle-bot
            - secretRef:
                name: squash-assistant-database-url
            - secretRef:
                name: squash-assistant-nats
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: false
          resources:
            requests:
              cpu: 25m
              memory: 64Mi
            limits:
              cpu: "250m"
              memory: 256Mi
          readinessProbe:
            httpGet:
              path: /health
              port: 8081
            initialDelaySeconds: 5
            periodSeconds: 30
          livenessProbe:
            httpGet:
              path: /health
              port: 8081
            initialDelaySeconds: 15
            periodSeconds: 30
```

Secret `squash-assistant-nats` doit contenir : `NATS_USER`, `NATS_PASSWORD`, `VINCENT_ALL_GROUP_JID` (et optionnellement override `NATS_URL`).

- [ ] **Step 4: Sceller le secret**

Récupérer le password `whatsapp-consumers` depuis le secret NATS cluster (`nats-auth` namespace `nats`), puis sceller dans le namespace `squash-assistant` avec le script / kubeseal habituel du homelab. Commit le SealedSecret généré.

Ne jamais committer le plaintext.

- [ ] **Step 5: Commit**

```bash
git add apps/listener/Dockerfile .github/workflows/build-push-listener.yml \
  kubernetes/listener-deployment.yaml kubernetes/squash-assistant-nats.sealed.yaml
git commit -m "$(cat <<'EOF'
feat(listener): Docker, CI GHCR et Deployment k8s

EOF
)"
```

---

### Task 10: Consumer JetStream (k3s-homelab) + docs

**Files:**
- Create (repo `k3s-homelab`): `kubernetes/nats/consumers/squash-assistant-listener.json`
- Create: `docs/adr/ADR-020-listener-nats-whatsapp-events.md`
- Modify: `docs/adr/README.md` (index)
- Modify: `docs/spec/regles-fonctionnelles.md`
- Modify: `docs/superpowers/specs/2026-08-04-whatsapp-events-listener-design.md` — corriger « manifests dans k3s-homelab » → Deployment dans ce repo, consumer JSON dans k3s-homelab

- [ ] **Step 1: JSON consumer** (identique à backoffice, nom différent)

```json
{
  "durable_name": "squash-assistant-listener",
  "filter_subject": "homelab.whatsapp.>",
  "deliver_policy": "all",
  "ack_policy": "explicit",
  "ack_wait": 30000000000,
  "max_deliver": 5,
  "max_ack_pending": 1000,
  "max_waiting": 512,
  "replay_policy": "instant"
}
```

- [ ] **Step 2: Appliquer**

```bash
cd ../k3s-homelab
./scripts/setup-nats-consumers.sh
# vérifier :
kubectl exec -n nats deploy/nats-box -- nats --user admin --password "$ADMIN_PW" \
  -s nats://nats:4222 consumer info WHATSAPP_EVENTS squash-assistant-listener
```

Commit dans k3s-homelab.

- [ ] **Step 3: ADR-020** — résumé : app dédiée, filtre payload, pas de PG audit, MCP `send_message`, consumer durable séparé du backoffice.

- [ ] **Step 4: `regles-fonctionnelles.md`** — ajouter une case :

  > Relais temps réel (listener NATS) : les events `poll_creation` / `poll_vote_*` des groupes dont une `booking_rule` est `enabled` (hors groupe Vincent All) sont résumés et postés dans le groupe WhatsApp Vincent All.

- [ ] **Step 5: Commit squash-assistant (docs) + commit k3s-homelab (consumer)**

---

### Task 11: Validation manuelle bout-en-bout

**Files:** aucun (ops)

- [ ] **Step 1:** S’assurer qu’au moins une `booking_rule` `enabled=true` pointe vers un vrai groupe WhatsApp (pas Vincent All), et que huddle-bot publie bien sur `WHATSAPP_EVENTS` avec subjects ADR-012.

- [ ] **Step 2:** Déployer listener (push main → CI → Argo sync). Vérifier logs :

```bash
kubectl -n squash-assistant logs deploy/squash-assistant-listener -f
```

Expected: `abonné stream=WHATSAPP_EVENTS consumer=squash-assistant-listener`

- [ ] **Step 3:** Depuis un groupe allowlist, voter sur un sondage bot (ou créer un sondage via le pipeline). Vérifier qu’un message apparaît dans Vincent All au format `[squash] …`.

- [ ] **Step 4:** Contrôles négatifs :
  - message texte dans le groupe allowlist → **pas** de relais
  - event dans Vincent All → **pas** de relais

- [ ] **Step 5:** Commit de suivi si ajustements mineurs de format (sinon rien).

---

## Spec coverage (self-review)

| Exigence spec | Task |
|---|---|
| `apps/listener` dédiée | 1, 8 |
| Consumer `squash-assistant-listener` / `homelab.whatsapp.>` | 8, 10 |
| Allowlist `booking_rules` enabled − Vincent All | 5 |
| Filtre `poll_creation` + `poll_vote_*` | 2, 3 |
| Subject sans type (filtre payload) | 2, 3, 7 |
| Format résumé | 4 |
| MCP `send_message` → Vincent All | 6 |
| ack / nak backoff / poison ack | 7 |
| Pas de table PG events | (aucun task table) |
| Hook `onResaEvent` pour WS phase 2 | 6 |
| Déploiement k8s + secrets | 9 |
| Consumer JSON k3s-homelab | 10 |
| Critères succès MVP | 11 |

Correction vs spec §8 : les Deployments vivent dans `squash-assistant/kubernetes/` (confirmé `install-k3s.md`), pas dans k3s-homelab — Task 10 met à jour la spec.
