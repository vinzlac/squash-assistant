# AGENTS.md — squash-assistant

Instructions for coding agents (Cursor, Claude Code, Codex, etc.).
Keep this file short. Product specs live in `docs/`.

## Project

Pipeline automatisé déclenché par le temps (pas un chat) qui remplace la gestion manuelle des réservations squash, en 4 étapes par groupe : **SendPoll → CollectVotes → BookSlots → Announce**. Délègue WhatsApp à **huddle-bot** et la réservation unitaire à **resa-squash** (MCP) ; ce repo orchestre, planifie localement, attend un « go » Telegram, annonce.

Coexiste volontairement avec l’agent OpenClaw en prod (ADR-007) — expérimentation séparée, pas un remplacement.

Stack: **TypeScript, npm workspaces, LangGraph.js, Postgres/Drizzle, Redis, Next.js (UI), NATS listener**.

## Run

```bash
# Prérequis : .env (voir .env.example), Postgres + Redis (docker-compose)
npm run db:migrate
npm run db:seed

npm run worker:dev    # pipeline + scheduler
npm run ui:dev        # admin Next.js
npm run listener:dev  # events WhatsApp (NATS)
```

Tests / checks :

```bash
npm test
npm run typecheck
npm run worker:test
npm run listener:test
```

## Specs (read when changing product/behavior)

- Plan / vision / phases : `docs/plan/squash-assistant-poc.md`
- Règles fonctionnelles (référence unique métier/UI) : `docs/spec/regles-fonctionnelles.md`
- ADRs (décisions d’architecture) : `docs/adr/README.md`
- Infra K3s (repo jumeau) : `k3s-homelab` → `docs/plan/plan-squash-assistant-k3s.md`

Ne pas inventer de `docs/product/mvp.md` ou `docs/architecture/overview.md` en doublon — le plan + spec + ADRs font foi.

## Structure

```text
apps/worker/     # scheduler, graphe LangGraph, MCP, Telegram
apps/ui/         # admin Next.js (LAN)
apps/listener/   # NATS WhatsApp events → PG / SSE
packages/db/     # schéma Drizzle, migrations, seeds
docs/plan/       # plan POC autoporteur
docs/spec/       # règles fonctionnelles
docs/adr/        # décisions architecture
kubernetes/      # manifests (worker, ui, postgres, redis, …)
graphify-out/    # knowledge graph (query avant grep large)
```

## Agent rules

1. Prefer the smallest change that solves the request — no over-engineering.
2. One clear responsibility per module/file.
3. Preserve existing behavior when refactoring.
4. Do not add unrequested features (pas de chat libre, pas de moteur workflow générique type n8n, pas de fusion avec OpenClaw).
5. Prefer idioms of TypeScript / npm workspaces / Drizzle / LangGraph.js.
6. Toute règle métier ou comportement UI → mettre à jour `docs/spec/regles-fonctionnelles.md` dans la même PR. Décision d’archi structurante → ADR. Lire le plan POC avant d’implémenter un flux pipeline.
7. Ne jamais committer de secrets (clés `sk_live_…`, tokens Telegram) — `.env` / SealedSecret uniquement.
8. **graphify** : si `graphify-out/graph.json` existe, `graphify query` / `path` / `explain` avant un grep large ; après modif de code, `graphify update .`.

## Verify

After relevant changes:

1. `npm run typecheck` (ou au moins le workspace touché).
2. `npm test` / tests du workspace modifié.
3. Si règle métier ou UI : spec `docs/spec/regles-fonctionnelles.md` à jour ; si décision d’archi : ADR.
