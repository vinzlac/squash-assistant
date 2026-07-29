# Design — Moteur de calcul du plan de réservation local à squash-assistant

**Statut** : approuvé pour passage en plan d'implémentation.
**Contexte** : suite à un bug de double-booking de court entre deux heures candidates (corrigé en aval, cf. commits `8f09498`/`109ccd5`/`5f19ed9`/`54b2f0e`), investigation du calcul du plan de réservation a révélé que toute la logique d'allocation (appariement des joueurs, choix de court, rotation, gestion du quota du titulaire de la clé API) vit côté `resa-squash` (`plan_group_bookings`), hors de portée de test et de contrôle de squash-assistant. Décision : rapatrier cette logique dans squash-assistant, `resa-squash` devenant un simple service de réservation unitaire de court (disponibilités + réservation/annulation), pas un moteur de planification.

## 1. Portée

**Fait dans ce projet** :
- Un nouveau module pur de calcul de plan (port fidèle de la logique actuelle de `resa-squash`), testable sans I/O.
- L'orchestration de `bookSlots.ts` mise à jour pour appeler ce module local au lieu de `plan_group_bookings`.
- Élargissement des types client MCP existants (`AvailabilitySlot`, retour de `list_my_reservations`) pour exposer des champs déjà renvoyés par resa-squash mais non modélisés côté squash-assistant aujourd'hui.
- Suppression du correctif de dépriorisation/détection de conflit de court entre heures candidates (`busyCourtsDuring`/`conflictingSessionIds` dans `capacityPlanning.ts`/`bookSlots.ts`/UI), devenu redondant : le nouveau moteur partage l'état des créneaux déjà retenus entre heures candidates par construction, le double-booking devient structurellement impossible plutôt que détecté après coup.
- Suite de tests unitaires sur le module de calcul pur : appariement pair/impair, quota titulaire, continuité de court, escalade, et le scénario exact du bug rapporté.

**Explicitement hors périmètre** :
- Aucun changement du contrat MCP de `resa-squash` (`plan_group_bookings` reste disponible pour OpenClaw, qui n'est pas touché — cf. ADR-007 coexistence).
- Pas de changement de règles métier par rapport au comportement actuel (port fidèle d'abord — décision utilisateur). Les ajustements de règles (ex. coupler deux prête-noms entre eux plutôt que substituer individuellement le titulaire à quota) sont un projet séparé, après validation du port.
- Pas de flag de bascule progressive : une fois les tests verts, `bookSlots.ts` n'appelle plus `plan_group_bookings` du tout (décision utilisateur, "bascule directe").

## 2. Primitives resa-squash utilisées (aucune n'est nouvelle)

Vérifié dans le code source de `resa-squash` (`app/api/mcp/route.ts`, `app/services/common.ts`) :

| Tool MCP | Usage |
|---|---|
| `list_availability(dateFrom, dateTo, courts?)` | Renvoie les créneaux bruts du/des jour(s) demandé(s), **tous courts confondus**, avec pour chaque créneau : `id` (= sessionId, utilisable directement par `reserve_slot`), `court`, `time`, `endTime`, `date`, `participants`, `available`, `users` (déjà occupé par qui, le cas échéant). C'est la même fonction (`getDailyReservations`) que celle utilisée en interne par `plan_group_bookings` aujourd'hui. |
| `list_my_reservations(fromDate?)` | Renvoie `{ userId, reservations }` — le `userId` est celui du titulaire de la clé API (déjà dans la réponse actuelle, jamais exploité côté squash-assistant). Sert à identifier le titulaire ET, combiné à `targetDate`, à compter son quota du jour (même donnée que `countBookingsInvolvingPlayerOnDay` côté resa-squash). |
| `reserve_slot` / `cancel_reservation` | Inchangés — seules primitives d'écriture réelle, déjà utilisées ainsi. |

**Point de vérification technique (Phase 1 du plan d'implémentation)** : le type client actuel `AvailabilitySlot` (`apps/worker/src/mcp/resaSquash.ts`) modélise `{ court, beginTime, endTime }` — mais le payload JSON réel renvoyé par `list_availability` correspond au type `Reservation` de resa-squash (`{ id, court, time, endTime, date, participants, available, users }`, champ `time` et non `beginTime`). Le type client n'a jamais été exercé (squash-assistant n'appelait jamais `list_availability` jusqu'ici). **À vérifier par un appel réel avant d'écrire le mapping**, plutôt que de supposer le nom exact des champs.

## 3. Module de calcul pur

Nouveau fichier `apps/worker/src/planning/groupBookingPlan.ts` (nom de dossier à confirmer en plan), port de `resa-squash/app/services/group-booking-plan.ts` :

**Entrée** (tout déjà en mémoire, aucun appel réseau dans ce module) :
- `availableSlots: Array<{ sessionId, court, beginTime, endTime, available, occupiedBy: string[] }>` (déjà filtré/normalisé depuis `list_availability`)
- `expectedPlayerIds: string[]`, `substitutePlayerIds: string[]`
- `apiUserId: string | null`, `apiUserDailyCount: number` (déjà compté via `list_my_reservations`), `maxDailyReservationsPerPlayer: number`
- `slotsPerPlayer: number`, `maxCourts: number`, `preferMinPlayersPerCourt: boolean`, `courtPriority: number[]`
- `usedSessionIds: ReadonlySet<string>` (créneaux déjà retenus par une heure candidate précédente dans le même run — remplace le correctif `busyCourtsDuring`)
- `startTimeFloor: string` (heure candidate — plancher horaire, remplace `explicitStartTime`)

**Sortie** : identique à `GroupBookingPlan` actuel (`proposedBookings`, `warnings`, `meta` avec `courtsNeeded`, `roundsPlanned`, `pairCount`, `rotatingPlayerIds`, etc.) — **aucun changement de ce type**, donc `capacityPlanning.ts`, `announce.ts`, `state.ts`, l'UI restent inchangés.

**Logique portée à l'identique** (voir `group-booking-plan.ts` source, fonctions de référence) :
- `buildPairsForGroupBooking` — appariement pair/impair, dernier joueur → 1er prête-nom dispo sinon rotation.
- `courtsNeededForPlayers` — `ceil(N / 2)` (`preferMin`) ou `ceil(N / 3)`, plafonné par `maxCourts` et par le nombre de courts du club (4, en dur comme aujourd'hui côté resa-squash — à confirmer si ça doit devenir un champ de config squash-assistant, cf. ouvert #1).
- `resolveCourtAssignments` — continuité de court sur 2 créneaux successifs d'une même paire avant `courtPriority`.
- Boucle de couches (`layer`) jusqu'à l'objectif `slotsPerPlayer`, avec substitution du titulaire à quota par le prochain prête-nom de la file, au fil de l'eau (pas tout d'un coup).
- Mêmes messages de `warnings` (texte identique où pertinent, pour ne pas casser les tests/attentes existants sur le libellé).

## 4. Orchestration (`bookSlots.ts`)

- Avant la boucle des heures candidates : un seul appel `list_availability(targetDate, targetDate)` (partagé entre toutes les heures candidates du job) + un appel `list_my_reservations` (ou `list_my_reservations_on_date`) pour le titulaire/quota.
- Dans la boucle, par heure candidate : appel du module pur avec `usedSessionIds` = tous les `sessionId` déjà retenus (non hors-fenêtre) par les heures candidates précédentes de ce run — remplace entièrement `busyCourtsDuring`/`conflictingSessionIds`.
- L'escalade min→max (ADR-014, `planWithEscalation`) reste : 2 appels au module local (`preferMinPlayersPerCourt` puis `false`), on garde le meilleur des deux — logique de retry inchangée, seul l'appel MCP est remplacé par un appel de fonction locale.
- Suppression de `busyCourtsDuring`, `conflictingSessionIds`, `courtIntervalsFromPlan` (capacityPlanning.ts) et du champ `conflictingSessionIds` sur `BookingPlanGroup` (state.ts, worker.ts UI, announce.ts, Pipeline.tsx) une fois le nouveau moteur validé — ce mécanisme devient mort du fait que le partage de `usedSessionIds` rend le conflit impossible par construction.

## 5. Ce qui n'est pas porté (spécifique à la config groupe resa-squash)

- Vérification d'appartenance au groupe (`NOT_GROUP_MEMBER`) — pas d'équivalent utile côté squash-assistant (le `resaSquashGroupId` de la `BookingRule` est déjà la source de vérité).
- Bornes `booking_min/max_slots_per_player` du groupe (clamp 1–6 + warning) — squash-assistant utilise directement `rule.maxReservationsPerPlayer`, pas de bornes de groupe séparées à valider.
- Filtre `recurring_weekday` — squash-assistant garantit déjà la bonne date cible via `targetWeekdayOffset` au moment de la création du job.

## 6. Tests

Le module étant pur, testable en isolant les 3 axes cités par l'utilisateur — courts disponibles, règles, joueurs confirmés — sans mock MCP lourd :

- Appariement pair (4 joueurs → 2 paires) et impair, avec prête-nom disponible et sans (rotation).
- Quota titulaire atteint : avec prête-nom disponible (substitution), sans prête-nom disponible (réservation ignorée pour cette paire, warning), file de prête-noms partagée entre plusieurs substitutions dans le même plan.
- Continuité de court sur 2 créneaux successifs d'une même paire, y compris le cas où le court le mieux classé (`courtPriority`) n'est libre que sur un seul des deux créneaux.
- Escalade `preferMinPlayersPerCourt` min→max quand la capacité manque au 1er essai.
- **Scénario de régression du bug rapporté** : 3 confirmés à une heure + 2 prête-noms + titulaire à quota + une heure candidate suivante avec 2 autres joueurs — vérifie qu'aucun court n'est proposé deux fois sur un créneau qui se chevauche entre les deux heures.
- Tests d'intégration légers sur `bookSlots.ts` (mock des tools `list_availability`/`list_my_reservations`/`reserve_slot`, pas de `plan_group_bookings`).

## 7. Rollout

Bascule directe (décision utilisateur) : une fois la suite de tests verte, `bookSlots.ts` n'appelle plus `plan_group_bookings`. Pas de flag de config, pas de comparaison en parallèle sur un groupe réel avant coupure — le port fidèle + les tests de régression sont considérés comme la garantie suffisante.

Un ADR (squash-assistant, prochain numéro après ADR-017) sera rédigé une fois l'implémentation faite, documentant ce changement de responsabilité architecturale (resa-squash : service de réservation unitaire ; squash-assistant : moteur de planification).

## 8. Questions ouvertes (à trancher en plan d'implémentation, pas bloquantes pour ce design)

1. `SQUASH_COURT_COUNT = 4` est en dur côté resa-squash — squash-assistant doit-il le dupliquer en dur aussi, ou en faire un champ de `BookingRule` (utile si un futur groupe a un nombre de courts différent) ?
2. Faut-il conserver `plan_group_bookings` dans `resaSquash.ts` (client MCP squash-assistant) comme code mort/référence, ou le retirer complètement du fichier une fois `bookSlots.ts` ne l'appelle plus ?
