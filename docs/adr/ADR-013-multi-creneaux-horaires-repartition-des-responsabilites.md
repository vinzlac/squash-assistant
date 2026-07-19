# ADR-013 : Sondage multi-créneaux horaires — répartition des responsabilités entre huddle-bot, resa-squash et squash-assistant

- **Statut** : accepted
- **Date** : 2026-07-19

## Contexte

Le besoin exprimé (2026-07-19) : pouvoir proposer **plusieurs heures de départ possibles** dans le sondage WhatsApp (ex. "18h45 ou 19h30 ?") plutôt qu'une heure unique — chaque participant choisit son heure, et l'assistant peut être amené à faire plusieurs réservations sur des créneaux et des courts différents selon qui a répondu quoi.

En creusant ce besoin, deux limites structurelles ont été mises au jour :

1. **`sessionStartTime` (BookingRule) n'a jamais été réellement honoré.** Un bug concret l'a révélé : un sondage demandant "15h" a abouti à une réservation à "12h45-14h15". Investigation (`listTools()` sur le MCP resa-squash) : le schéma de `plan_group_bookings` ne contient **aucun paramètre d'heure** (`groupId`, `onDate`, `expectedPlayerIds`, `substitutePlayerIds`, `slotsPerPlayer`, `dryRun`, `timeZone` — exhaustif, `additionalProperties: false`). L'algorithme (`app/services/group-booking-plan.ts` côté resa-squash) est glouton : il prend le **premier créneau disponible** le jour demandé, `recurringStartTime` du groupe n'agissant que comme un **plancher** (`>=`), jamais une cible.
2. **`ask_poll` (huddle-bot) est codé en dur sur 2 options (Oui/Non).** Investigation dans le repo huddle-bot : la librairie sous-jacente (Baileys) supporte déjà nativement des sondages WhatsApp à N options, et `get_responses` lit déjà la sélection précise par option (`getPollTally`/`formatPoll`) — mais ce résultat riche est **réduit** à oui/non par `buildPollStatusMaps` (correspondance de texte), qui jette l'information de l'option choisie.

Ces deux limites, plus le constat déjà documenté dans [ADR-003](./ADR-003-delegation-logique-metier-mcp.md) ("Conséquences" : `maxCourtsPerSlot`, `minPlayersPerCourt`, `maxPlayersPerCourt`, `preferMinPlayersPerCourt`, `courtPriority` sont stockés dans `BookingRule` mais **inertes**, faute de paramètre équivalent côté resa-squash), pointent vers la même question : où doit vivre la décision "combien de courts, quel remplissage, quel ordre de préférence, à quelle(s) heure(s)" ?

## Décision

**squash-assistant devient responsable de la stratégie d'allocation** (quelles heures candidates, combien de courts, remplissage min/max, ordre de préférence des courts). **resa-squash reste responsable des primitives dépendantes de TeamR** : disponibilités réelles, pairing des joueurs par court (gestion de l'effectif impair via rotation), et le quota de 2 réservations/jour/joueur — ces règles sont indépendantes du client appelant (squash-assistant ou un autre), déjà écrites et testées côté resa-squash, et ne doivent pas être dupliquées.

Concrètement :

### huddle-bot
- `ask_poll` accepte une liste d'options (`options: string[]`) au lieu de "Oui/Non" figé — le plumbing (`createPoll` → Baileys) le supporte déjà, seule la couche `poll-requests.ts` (constante `POLL_OPTIONS`, schéma MCP) est à généraliser.
- `get_responses` renvoie l'option réellement choisie par chaque votant (`statut` élargi d'une union figée `oui|non|ambigu|aucune_reponse` à la valeur de l'option, ex. `"18H45"`) au lieu de la réduire à oui/non — `buildPollStatusMaps` ne doit plus collapser le résultat déjà structuré par `formatPoll`.

### resa-squash
- `plan_group_bookings` reçoit une cible d'heure explicite et les leviers de stratégie, au lieu de chercher lui-même "le plus tôt disponible" :
  ```ts
  interface PlanGroupBookingsParams {
    groupId: string;
    onDate: string;
    expectedPlayerIds: string[];        // uniquement les joueurs ayant choisi CETTE heure
    substitutePlayerIds?: string[];
    startTime: string;                  // NOUVEAU — cible exacte (ex. "18H45"), remplace recurringStartTime comme plancher
    slotsPerPlayer?: number;
    maxCourts?: number;                  // NOUVEAU — maxCourtsPerSlot de BookingRule
    preferMinPlayersPerCourt?: boolean;  // NOUVEAU
    courtPriority?: number[];            // NOUVEAU
    dryRun?: boolean;
    timeZone?: string;
  }
  ```
- resa-squash garde intégralement : la recherche de disponibilité réelle autour de `startTime`, l'algorithme de "vagues"/couches pour `slotsPerPlayer` > 1, le pairing (constitution des paires, rotation si effectif impair), et la vérification du quota 2 résas/jour/joueur.

### squash-assistant
- `BookingRule.sessionStartTime` (heure unique) devient une **liste d'heures candidates**.
- `sendPoll` construit le sondage multi-choix à partir de cette liste (+ une option "Non").
- `collectVotes` regroupe les joueurs confirmés **par heure choisie** (`confirmedPlayerIdsByTime: Record<string, string[]>`) au lieu d'une liste plate.
- `bookSlots` itère sur ce regroupement et appelle `plan_group_bookings` **une fois par heure distincte**, avec ses propres `maxCourtsPerSlot`/`preferMinPlayersPerCourt`/`courtPriority`/`minPlayersPerCourt`/`maxPlayersPerCourt` en paramètres — ce qui les rend enfin actionnables.
- `announce` fusionne les plans de tous les groupes d'heure dans un seul message WhatsApp.
- L'UI (`Pipeline.tsx`) affiche : l'heure (ou les heures) proposées à l'étape 1, qui a répondu quoi par heure à l'étape 2, le détail jour/heure/court/personnes par groupe à l'étape 3, le message WhatsApp réellement envoyé à l'étape 4 (ce dernier point déjà livré indépendamment de cet ADR).

## Alternatives considérées

- **squash-assistant réimplémente aussi le pairing/rotation/quota** (allocation complète en local, resa-squash réduit à `list_availability` + `reserve_slot`). Rejeté : duplique une logique métier TeamR déjà écrite et testée côté resa-squash (risque de divergence sur les quotas notamment), et va à l'encontre de la raison d'être d'[ADR-003](./ADR-003-delegation-logique-metier-mcp.md).
- **Garder `recurringStartTime` comme unique mécanisme de ciblage horaire** (ajuster la config du groupe resa-squash à chaque fois). Rejeté : ce n'est qu'un plancher (`>=`), pas une cible, et c'est une config globale au groupe — incompatible avec l'idée même de plusieurs heures candidates par sondage.

## Conséquences

- Travail réparti sur **3 repos** : huddle-bot (sondage multi-choix), resa-squash (nouveau contrat `plan_group_bookings`), squash-assistant (modèle `BookingRule`, graphe LangGraph, UI).
- `plan_group_bookings` change de contrat de manière **non rétrocompatible** (`startTime` devient probablement requis, `recurringStartTime`/`recurringWeekday` du groupe cessent d'être la source de vérité pour le ciblage horaire) — sans risque pour un tiers, ce tool n'ayant aucun consommateur en dehors de squash-assistant (vérifié : aucune page UI resa-squash ne l'appelle, seul un agent d'automatisation — historiquement OpenClaw, maintenant aussi squash-assistant — l'utilise).
- `BookingRule` passe d'une heure de session unique à une liste — migration de schéma Postgres (`packages/db`) à prévoir, et adaptation des règles existantes (`squashacademie-mardi`, `test-vincent-all`, etc.) pour lister une seule heure candidate au minimum, sans changement de comportement immédiat.
- Ce changement révise la portée d'[ADR-003](./ADR-003-delegation-logique-metier-mcp.md) sans le contredire : squash-assistant reste délibérément mince sur le pairing/rotation/quota TeamR (toujours délégué), mais absorbe la décision de stratégie d'allocation qu'ADR-003 avait explicitement laissée "à revisiter si le tool évolue".

## Plan de mise en œuvre

### Phase 1 — huddle-bot (sondage multi-choix)
1. Généraliser `ask_poll` : schéma MCP + `poll-requests.ts` pour accepter `options: string[]` (au lieu de `POLL_OPTIONS` figé), thread jusqu'à `wa.createPoll`.
2. Élargir le type `Statut`/`PollResponse.statut` d'une union figée à `string`.
3. Adapter `buildPollStatusMaps` pour renvoyer le nom de l'option réellement votée (`option.name`) plutôt que de le réduire à oui/non.
4. Vérifier `delete_message`/l'historique des `pollRequests.options` (déjà `jsonb`, pas de migration DB attendue).
5. Test manuel bout en bout : sondage à 3 options réel sur le groupe de test, vérifier que `get_responses` renvoie bien l'option choisie par votant.

### Phase 2 — resa-squash (`plan_group_bookings` généralisé)
1. Ajouter `startTime`, `maxCourts`, `preferMinPlayersPerCourt`, `courtPriority` au schéma zod du tool (`app/api/mcp/route.ts`).
2. Adapter `group-booking-plan.ts` : remplacer le filtre `recurringStartTime` (plancher `>=`) par un filtre sur `startTime` exact ; brancher `maxCourts` comme plafond du nombre de courts choisis par vague ; brancher `preferMinPlayersPerCourt` dans la logique de remplissage (aujourd'hui implicite) ; utiliser `courtPriority` pour l'ordre de sélection des courts (au lieu d'un ordre arbitraire).
3. Garder `recurringWeekday`/`recurringStartTime` du groupe en fallback si `startTime` n'est pas fourni (rétrocompatibilité avec l'agent OpenClaw existant, qui utilise peut-être encore l'ancien contrat — à vérifier).
4. Étendre les tests existants (`group-booking-plan.test.ts`) pour les nouveaux paramètres.
5. Documenter le changement de contrat (ADR côté resa-squash).

### Phase 3 — squash-assistant (modèle + graphe)
1. Migration Postgres : `BookingRule.sessionStartTime` (string) → `candidateStartTimes` (liste), avec migration des règles existantes vers une liste à un seul élément.
2. `sendPoll.ts` : construire les options du sondage à partir de `candidateStartTimes`.
3. `collectVotes.ts`/`resolveVotes.ts` : regrouper `confirmedPlayerIds` par heure choisie (`confirmedPlayerIdsByTime`), adapter `PipelineState`.
4. `bookSlots.ts`/`buildBookingParams.ts` : boucle sur les groupes d'heure, un appel `plan_group_bookings` par groupe, agrégation des `proposedBookings`.
5. `announce.ts`/`slotMerge.ts` : fusionner l'annonce sur plusieurs groupes d'heure (actuellement une seule fusion de créneaux contigus).
6. `test:graph` : étendre le scénario mock pour couvrir 2 heures candidates avec des joueurs différents par heure.

### Phase 4 — UI (`Pipeline.tsx`)
1. Étape 1 : afficher la ou les heures candidates du sondage (pas seulement la date).
2. Étape 2 : lister qui a répondu oui à quelle heure, et qui a répondu non/n'a pas répondu.
3. Étape 3 : afficher le détail jour/heure/court/personnes par groupe d'heure (pas un seul plan plat).
4. Étape 4 : déjà livré indépendamment (affichage du message WhatsApp réellement envoyé).

Chaque phase est livrable et testable indépendamment (huddle-bot et resa-squash n'ont pas de dépendance croisée entre eux ; squash-assistant dépend des deux mais peut être développé avec des mocks avant l'intégration réelle, cf. `test:graph`).
