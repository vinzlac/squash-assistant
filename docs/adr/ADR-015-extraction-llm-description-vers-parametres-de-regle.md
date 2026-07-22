# ADR-015 – Extraction LLM : description en français → paramètres de règle

**Status:** accepted
**Date:** 2026-07-22

## Contexte

squash-assistant n'a aujourd'hui **aucune intégration LLM** — c'est un pipeline déterministe qui délègue toute logique métier aux MCP externes (ADR-003) et refuse volontairement d'être un moteur de workflow générique (ADR-006). Demande explicite : pouvoir décrire une règle de réservation en français libre et en extraire automatiquement les paramètres techniques (`pollCron`, `candidateStartTimes`, `courtPriority`, etc.), en plus du sens inverse (paramètres → description, déjà couvert par `describeRuleInFrench`, déterministe, sans LLM — voir ADR-014 addendum).

Aller de la description vers les paramètres n'est **pas** automatisable sans LLM (texte libre, non structuré) — contrairement au sens inverse. C'est donc une exception ponctuelle et isolée au principe "pas de logique métier ad hoc dans squash-assistant", limitée à une fonctionnalité d'aide à la saisie (édition de règle), **jamais** utilisée dans le chemin d'exécution du pipeline lui-même (sondage/votes/réservation restent 100% déterministes, MCP uniquement).

huddle-bot fait déjà exactement ce type d'extraction structurée pour classifier les réponses de sondage (oui/non/ambigu) via l'API Anthropic — pattern repris ici plutôt que d'en inventer un nouveau.

## Décision

- **Fournisseur** : API Anthropic (`@anthropic-ai/sdk`), modèle `claude-haiku-4-5-20251001` — même choix que huddle-bot (rapide, peu coûteux, suffisant pour une extraction structurée).
- **Pattern** : tool-use forcé (`tool_choice: {type: "tool", name: ...}`) avec un schéma JSON couvrant les champs réellement décrits en prose par `describeRuleInFrench` — exclut `id`/`name`/`enabled`/`whatsappGroupJid`/`resaSquashGroupId` (choisis via l'UI, jamais rédigés en texte libre).
- **Secret** : `ANTHROPIC_API_KEY`, dédié à squash-assistant (pas de partage avec la clé huddle-bot, pour ne pas mélanger facturation/quota des 2 apps) — **pas encore scellé/déployé**, nécessaire seulement pour les tests d'intégration en attendant l'implémentation du bouton UI (phase suivante).
- **Tests d'intégration réels** (`apps/worker/src/llm/ruleParamsExtraction.integration.test.ts`) : round-trip complet sur les 3 règles réelles connues (`@squash-assistant/db/fixtures/realRules`) — `describeRuleInFrench` (déterministe) génère la description, le LLM l'extrait, comparé aux vraies valeurs. **Jamais dans `npm test`/CI** (appels facturés, non déterministes) : script séparé `npm run test:llm` (`vitest.integration.config.ts`), silencieusement skip si `ANTHROPIC_API_KEY` absent.

## Conséquences

- Nouvelle dépendance `@anthropic-ai/sdk` dans `apps/worker`.
- Nouveau module `apps/worker/src/llm/` (`anthropicClient.ts`, `ruleParamsExtraction.ts`) + route HTTP `POST /rules/generate-params` (`apps/worker/src/http/server.ts`).
- Fixture partagée `packages/db/src/fixtures/realRules.ts` (les 3 règles réelles) — utilisée par les tests `describeRuleInFrench` (packages/db) et les tests d'intégration LLM (apps/worker), pour valider les 2 sens sur les mêmes données.
- UI : panneau `RuleGeneratorPanel` (composant client) sur la page de règle — "texte → paramètres" appelle la route worker via une Server Function (`generateRuleParamsAction`) ; "paramètres → texte" reste 100% local (`describeRuleInFrench` tourne aussi côté client, aucun secret nécessaire pour ce sens).
- `ANTHROPIC_API_KEY` scellé (clé Anthropic dédiée à squash-assistant, créée par l'utilisateur, stockée dans gopass sous `vault/env/squash-assistant/anthropic-api-key`) et montée sur le worker (`kubernetes/squash-assistant-anthropic.sealed.yaml`).
- **Correction post-validation réelle (2026-07-22)** : les 3 tests d'intégration réels ont d'abord révélé une vraie erreur d'extraction — `squashacademie-mardi` ("mardi à 21H30") donnait le cron `0 21 * * 2` (minutes perdues) au lieu de `30 21 * * 2`. Corrigé en ajoutant des exemples de conversion jour/heure → cron explicites dans le system prompt (dont un cas "21H30" → minute=30, pas 0) et en précisant la règle dans la description du champ JSON schema. Les 3 tests passent de façon stable après correction (vérifié sur 2 exécutions successives).
