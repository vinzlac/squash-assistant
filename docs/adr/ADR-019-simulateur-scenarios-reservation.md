# ADR-019 – Simulateur de scénarios de réservation

**Status:** accepted
**Date:** 2026-08-01

## Contexte

Chaque ajustement de règle métier du moteur d'allocation (`apps/worker/src/planning/`, ADR-018) n'était vérifiable qu'en écrivant des tests unitaires à la main ou en observant le comportement réel en production — deux corrections coup sur coup le 2026-08-01 (continuité de court avec prête-nom changeant, plafond de résas/jour appliqué au mauvais joueur) ont montré le besoin d'un outil de vérification visuelle avant déploiement.

## Décision

### 1. Scénarios comme entité de première classe, liée à une règle précise

Nouvelle table `scenarios` (FK vers `booking_rules`, `ON DELETE CASCADE`) : un jeu de joueurs avec leur vote, un statut de validation manuel (OK / pas OK / non évalué), un cache du dernier plan calculé.

### 2. Réutilisation stricte du moteur de production

`bookSlots.ts` (nœud réel) et le simulateur appellent tous les deux `planJobBookings` (nouveau module partagé, `planning/planJob.ts`, extrait de la boucle candidate-heure de `bookSlots.ts`) — seule la source de la disponibilité des courts diffère (réelle via `list_availability`, synthétique "tout libre" pour le simulateur). Aucune logique dupliquée : toute divergence de comportement invaliderait l'utilité du simulateur comme outil de décision.

### 3. CRUD scénarios en accès DB direct depuis l'UI, calcul de plan via le worker

Contrairement aux jobs (`job_runs`), qui passent par l'API HTTP interne du worker parce qu'ils dépendent de l'état LangGraph, les scénarios sont de simples lignes DB sans composante d'orchestration — leur CRUD suit donc le pattern déjà utilisé pour `booking_rules` (accès Drizzle direct depuis les Server Actions `apps/ui`). Seul le calcul du plan (`computeGroupBookingPlan`/`planJobBookings`, code qui vit dans `apps/worker`) passe par un nouvel endpoint HTTP `POST /rules/:id/scenarios/:scenarioId/simulate`.

### 4. Verrouillage d'une règle référencée par un scénario

Une règle avec au moins un scénario ne peut plus être modifiée (les scénarios ne portent que sur les votes des joueurs — la règle elle-même doit rester stable pour que le scénario garde son sens). Défense en profondeur : garde côté UI (formulaire remplacé par un message) et côté serveur (`upsertRuleAction` lève une erreur explicite).

### 5. Export manuel vers une suite de non-régression versionnée

Aucune écriture directe dans le repo git depuis un pod (UI et worker n'ont pas de checkout du repo en prod) : "Exporter" télécharge un JSON, à déposer manuellement dans `apps/worker/src/planning/__fixtures__/scenarios/` et committer. `scenarios.regression.test.ts` parcourt ce dossier à chaque exécution de `npm test` et vérifie que chaque fixture produit toujours le plan attendu.

## Raisons

- Un outil de vérification visuelle avant déploiement réduit le risque de régression fonctionnelle silencieuse sur la logique de réservation — deux bugs de comportement corrigés le même jour (2026-08-01) auraient été détectés plus tôt avec cet outil en place.
- Réutiliser `planJobBookings` plutôt que dupliquer la boucle de planification est la seule façon pour le simulateur de rester une source de vérité fiable dans la durée.
- Suivre le pattern d'accès DB déjà en place pour `booking_rules` (plutôt qu'un détour systématique par le worker) évite une couche HTTP inutile pour de simples opérations CRUD.

## Conséquences

- `apps/worker/src/planning/planJob.ts`, `simulateScenario.ts`, `scenarios.ts` : nouveaux modules.
- `apps/worker/src/graph/nodes/bookSlots.ts` : refactorisé pour appeler `planJobBookings` (comportement inchangé, couvert par `bookSlots.test.ts`).
- `apps/ui/src/lib/scenarios.ts`, `apps/ui/src/app/rules/[id]/simulator/**` : nouvelle section UI.
- `packages/db/src/schema.ts` : nouvelle table `scenarios`.
- Aucun changement de contrat MCP (huddle-bot, resa-squash) — le simulateur n'appelle aucun des deux au moment du calcul de plan.
