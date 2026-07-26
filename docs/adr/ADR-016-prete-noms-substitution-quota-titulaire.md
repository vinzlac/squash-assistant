# ADR-016 – Prête-noms (`substituteBookers`) en repli du quota titulaire

**Status:** accepted
**Date:** 2026-07-26

## Contexte

Constat en usage réel (`squash-samedi-matin`, 2026-08-01) : un plan de réservation s'est arrêté avec un court réellement libre sur TeamR, parce que le titulaire de la clé API (compte utilisé pour tous les appels resa-squash) avait déjà atteint son plafond « maison » de réservations/jour (2 par défaut, pas une limite TeamR — confirmé, c'est une limite de courtoisie propre au groupe). Le détail de la cause racine et le fix côté MCP externe sont documentés dans `resa-squash/docs/adr/010-quota-titulaire-scope-et-prete-noms-substitution.md` (repo séparé) : le check ne bloque désormais que la paire qui inclut réellement le titulaire, et `plan_group_bookings` accepte déjà un mécanisme de prête-nom (`substitutePlayerIds`) — jusqu'ici utilisé uniquement pour l'effectif impair, maintenant étendu pour remplacer le titulaire à quota.

Ce qui manque côté squash-assistant : aucune règle n'expose de liste de prête-noms configurable, et `buildPlanGroupBookingsParams` ne passe jamais `substitutePlayerIds` à l'appel MCP. Besoin exprimé : pouvoir configurer, par groupe (`BookingRule`), une liste ordonnée (priorité) de prête-noms à utiliser en dernier recours — en excluant automatiquement quiconque est déjà un joueur confirmé (sondage) sur une autre heure candidate du même jour, puisqu'une même personne ne peut pas être à la fois joueuse réelle sur un créneau et prête-nom sur un autre.

## Décision

### 1. Deux nouveaux champs sur `BookingRule`

- **`substituteBookers: string[]`** (défaut `[]`) — userIds resa-squash, dans l'ordre de priorité d'utilisation comme prête-nom.
- **`maxDailyReservationsPerPlayer: number`** (défaut `2`) — transmis tel quel au nouveau paramètre `maxDailyReservationsPerPlayer` de `plan_group_bookings` (resa-squash ADR-010) ; par groupe, pas de config globale (confirmé : la limite peut différer d'un groupe à l'autre).

### 2. Calcul des prête-noms éligibles par appel, pas une liste statique

`bookSlots.ts` construit, avant la boucle sur `candidateStartTimes`, un ensemble `usedTodayIds` initialisé avec **tous** les joueurs confirmés du jour, toutes heures candidates confondues (`Object.values(confirmedPlayerIdsByTime).flat()`) — un prête-nom qui joue réellement à une autre heure ce jour-là n'est jamais proposé comme substitut. Pour chaque heure traitée, `buildPlanGroupBookingsParams` calcule `substitutePlayerIds = rule.substituteBookers` filtré de `usedTodayIds` et des `confirmedPlayerIds` de cette heure, dans l'ordre de priorité configuré.

Après chaque appel `plan_group_bookings`, `bookSlots.ts` inspecte les `proposedBookings` retournés : tout `userId`/`partnerId` présent dans `rule.substituteBookers` mais absent des `confirmedPlayerIds` de cette heure a été effectivement utilisé comme prête-nom par resa-squash (odd-effectif ou substitution quota) — il est ajouté à `usedTodayIds` avant de traiter l'heure candidate suivante, pour ne jamais réutiliser deux fois le même prête-nom le même jour.

### 3. Rien de nouveau côté LangGraph/state

`substitutePlayerIds` est un simple paramètre d'appel supplémentaire (comme `courtPriority`) — aucun nouveau nœud, aucun champ d'état LangGraph. La détection « qui a été utilisé » se fait par diff sur les `proposedBookings` déjà retournés, pas par un retour structuré dédié côté resa-squash (aucune évolution d'API nécessaire au-delà de l'ADR-010).

## Raisons

- Réutiliser tel quel le mécanisme `substitutePlayerIds` déjà accepté par resa-squash (ADR-010 là-bas) plutôt qu'inventer un concept parallèle — un prête-nom est un prête-nom, que ce soit pour un effectif impair ou un titulaire à quota.
- Le filtrage par `usedTodayIds` (calculé à la volée, pas stocké) évite la complexité d'un état partagé explicite : une seule structure locale à la boucle de `bookSlots.ts`, recalculée à chaque exécution du nœud.
- `maxDailyReservationsPerPlayer` par règle (pas de config globale) : confirmé que ce plafond de courtoisie peut légitimement varier d'un groupe WhatsApp à l'autre.

## Conséquences

- Migration DB : `booking_rules.substitute_bookers jsonb default '[]'`, `booking_rules.max_daily_reservations_per_player integer default 2`.
- `packages/db/src/schema.ts`, `packages/db/src/ruleDescription.ts` (+ test), `packages/db/seeds/booking-rules.seed.json`, `packages/db/src/fixtures/realRules.ts` : nouveaux champs.
- `apps/worker/src/mcp/resaSquash.ts` : `PlanGroupBookingsParams.maxDailyReservationsPerPlayer?: number`.
- `apps/worker/src/graph/buildBookingParams.ts` : nouveau paramètre `usedTodayIds` (calcul des `substitutePlayerIds` éligibles), passage de `maxDailyReservationsPerPlayer`.
- `apps/worker/src/graph/nodes/bookSlots.ts` : construction et mise à jour de `usedTodayIds` au fil de la boucle sur les heures candidates.
- `apps/ui/src/app/rules/RuleForm.tsx` (+ `actions.ts` pour le parsing du formulaire) : 2 nouveaux champs, tableau userId→nom pour les prête-noms (même pattern que `priorityBookers`).
- `apps/worker/src/llm/ruleParamsExtraction.ts` : `substituteBookers`/`maxDailyReservationsPerPlayer` ajoutés au schéma d'extraction (ADR-015).
- `docs/spec/regles-fonctionnelles.md` : nouvelle section documentant la règle de sélection des prête-noms.
- **Non traité par cet ADR** : afficher dans l'UI (étape 3/4 du pipeline) qu'un prête-nom a été utilisé à la place d'un joueur attendu — l'information existe déjà dans les `warnings` bruts de resa-squash (affichés depuis le fix du 2026-07-25), pas de traitement dédié supplémentaire pour l'instant.
