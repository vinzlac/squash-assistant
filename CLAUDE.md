# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Vision

**⚠️ Ce n'est pas un assistant conversationnel.** squash-assistant n'a pas d'UI et ne répond pas à des prompts libres d'un utilisateur. C'est un **pipeline automatisé déclenché par le temps** (scheduler interne, pas de webhook entrant WhatsApp) qui **remplace la personne qui gère aujourd'hui les réservations manuellement**, selon un processus fixe en 4 étapes répété chaque semaine par groupe :

1. **SendPoll** — à l'heure T configurée, envoyer un sondage WhatsApp ("qui joue la semaine prochaine ?") + log Telegram.
2. **CollectVotes** — un peu avant le soir du même jour, lire les réponses (déjà classifiées oui/non/ambigu par huddle-bot) + log Telegram.
3. **BookSlots** — à une heure donnée (variable selon le jour/groupe), planifier la réservation pour J+7 en dry-run, envoyer le plan sur Telegram, **attendre une confirmation "go" avant de réserver**, puis réserver + log Telegram.
4. **Announce** — informer le groupe WhatsApp des créneaux pris, en **regroupant les créneaux adjacents** pour la clarté + log Telegram.

Ce repo **ne réinvente pas la logique métier déjà déléguée aux deux MCP externes** (allocation des créneaux côté resa-squash, interprétation des votes côté huddle-bot). Ce qui reste propre à squash-assistant : le scheduler, l'enchaînement des 4 étapes, la validation humaine avant réservation, et le formatage de l'annonce finale :
- **huddle-bot** — MCP d'exécution WhatsApp (sondage, lecture des votes, envoi de messages)
- **resa-squash** — MCP de réservation de terrain (disponibilités, planification, réservation via l'API TeamR)

Un bot Telegram dédié sert de canal de log **et** de confirmation ("go") pour le POC — dry-run uniquement, aucune réservation réelle tant que la Phase 4 du plan n'en décide autrement.

**Le plan complet et à jour est dans [`docs/plan/squash-assistant-poc.md`](docs/plan/squash-assistant-poc.md) — à lire en entier avant toute implémentation.** Il contient, de façon autoporteuse (pas besoin d'accès aux repos huddle-bot/resa-squash) :
- les endpoints, schémas de tools et auth des deux MCP,
- les décisions techniques (LangGraph.js, Redis dédié, scopes de clés API),
- le déroulement du mini-POC,
- les phases d'implémentation (0 à 4),
- les points ouverts.

## Positionnement vis-à-vis de l'existant

Un agent **OpenClaw** (déjà en prod, orchestré par crons) fait aujourd'hui la même chose que ce que ce POC explore, via une approche différente (pas LangGraph). Les deux **coexistent délibérément** — squash-assistant est une expérimentation séparée, pas un remplacement. Voir §1 du plan pour le détail de cette décision (actée le 2026-07-12), ainsi que [ADR-007](docs/adr/ADR-007-coexistence-openclaw.md).

## Décisions d'architecture

Les choix structurants (framework, persistance, délégation aux MCP externes, modèle "jobs", etc.) sont documentés au fil de l'eau dans [`docs/adr/`](docs/adr/README.md) — à consulter avant de remettre en cause une décision déjà actée.

## Repo jumeau côté infrastructure

Le déploiement K3s (PaaS, Redis self-hosted, secrets) est documenté séparément dans le repo `k3s-homelab` : `docs/plan/plan-squash-assistant-k3s.md`. Ce repo-ci (`squash-assistant`) ne contient pas de manifests Kubernetes — ils vivent côté `k3s-homelab`, comme le reste des apps du cluster (mode PAAS).

## État actuel

Repo tout juste initialisé — aucun code encore écrit. Prochaine étape : Phase 0 du plan (setup TS/pnpm, dépendances LangGraph.js + client MCP, `.env.example`, ressources K8s).

## Commandes

*(À compléter au fur et à mesure du bootstrap — voir Phase 0 du plan pour la liste des tâches de setup.)*

## Secrets

Ne jamais commiter de clé API en clair. Suivre le pattern du plan (`docs/plan/squash-assistant-poc.md` §2) : clés `sk_live_...` dédiées au POC (scope `READ_ONLY` par défaut) pour huddle-bot et resa-squash, token + `chat_id` du bot Telegram dédié — toutes injectées via `.env` en local et `SealedSecret` sur K3s (jamais en clair dans ce repo).
