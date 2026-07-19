# Plan — Sondage multi-créneaux horaires

**Date** : 2026-07-19
**Statut** : Phases 1 (huddle-bot), 2 (resa-squash), 3 (squash-assistant) et 4 (UI) codées — huddle-bot poussé/déployé, resa-squash et squash-assistant commités localement (push demandé)
**Décision d'architecture** : voir [ADR-013](../adr/ADR-013-multi-creneaux-horaires-repartition-des-responsabilites.md) pour le contexte, les alternatives considérées et le contrat détaillé entre les 3 repos. Ce document ne fait que suivre la progression, phase par phase — pour le "pourquoi", se référer à l'ADR.

**Repos concernés** : `huddle-bot`, `resa-squash`, `squash-assistant` (ce repo). Chaque phase est livrable et testable indépendamment ; squash-assistant peut être développé avec des mocks (`test:graph`) avant l'intégration réelle avec les deux autres.

---

## Phase 1 — huddle-bot : sondage multi-choix natif

- [x] Généraliser `ask_poll` : schéma MCP (`app/api/mcp/route.ts`) + `poll-requests.ts` pour accepter `options: string[]` au lieu de `POLL_OPTIONS` figé (`['Oui', 'Non']`)
- [x] Thread `options` jusqu'à `wa.createPoll` (déjà générique côté Baileys — pas de changement nécessaire là)
- [x] Élargir le type `Statut`/`PollResponse.statut` d'une union figée (`oui|non|ambigu|aucune_reponse`) à `string`
- [x] Adapter `buildPollStatusMaps` pour renvoyer `option.name` (l'option réellement votée) au lieu de collapser vers oui/non — synonymes historiques oui/non toujours normalisés en minuscules (rétrocompatible)
- [x] Vérifié : `pollRequests.options` (déjà `jsonb`) n'a pas besoin de migration
- [x] **Test manuel** : sondage à plusieurs options réel sur WhatsApp validé via le bouton "Créer un sondage" de l'UI huddle-bot (confirme que WhatsApp/Baileys accepte bien un sondage à N options) — **note** : ce chemin UI ne passe pas par `ask_poll`/`get_responses` (il appelle `wa.createPoll` directement, sans créer de ligne `pollRequests`), donc le test bout en bout du code réellement modifié (`get_responses`/`buildPollStatusMaps`) reste à valider à l'usage, une fois la Phase 3 câblée dessus
- [x] Documenter le changement dans un ADR côté huddle-bot (`docs/adr/ADR-011-ask-poll-multi-options.md`)

Commit `066388b` (`feat(mcp): ask_poll accepte des sondages à choix multiples`) — **poussé** sur `main` (huddle-bot), déployé.

## Phase 2 — resa-squash : `plan_group_bookings` généralisé

- [x] Ajouté au schéma zod du tool (`app/api/mcp/route.ts`) : `startTime`, `maxCourts`, `preferMinPlayersPerCourt`, `courtPriority` (tous optionnels)
- [x] Adapté `group-booking-plan.ts` : `filterByRecurringPreferences` accepte `explicitStartTime` (format TeamR, parsé via `parseTeamrSlotTimeToMinutes`) — remplace `recurringStartTime` comme plancher (`>=`, pas égalité stricte — les rounds suivants d'un plan multi-slots avancent naturellement) et dispense du filtre `recurringWeekday`
- [x] Branché `maxCourts` comme plafond du nombre de courts choisis par vague (`pickCourtsForWave`, en plus du plafond club `SQUASH_COURT_COUNT`)
- [x] Branché `preferMinPlayersPerCourt` — `courtsNeededForPlayers` accepte un flag pour basculer `MAX_PLAYERS_PER_COURT_GROUP` (3/court, défaut) vers `MIN_PLAYERS_PER_COURT_GROUP` (2/court)
- [x] `courtPriority` utilisé pour l'ordre de sélection des courts (`orderByCourtPriority`, défaut : ordre croissant inchangé)
- [x] `recurringWeekday`/`recurringStartTime` du groupe restent le fallback si `startTime` n'est pas fourni — comportement historique strictement inchangé (rétrocompatible avec l'agent OpenClaw existant)
- [x] `group-booking-plan.test.ts` étendu : 4 nouveaux tests (startTime bypass recurringWeekday, maxCourts plafonne meta.courtsNeeded, preferMinPlayersPerCourt change le nombre de courts, courtPriority change l'ordre) — suite complète verte (39 tests)
- [x] Documenté dans `docs/adr/008-plan-group-bookings-parametres-strategie.md` (resa-squash) — `docs/openclaw-mcp-agent-prod.md` mis à jour en cohérence

Commit `92f78f7` (`feat(mcp): plan_group_bookings accepte startTime/maxCourts/preferMinPlayersPerCourt/courtPriority`) — **pas encore poussé** (confirmation demandée avant push, resa-squash gère de vraies réservations club).

## Phase 3 — squash-assistant : modèle + graphe LangGraph

- [x] Migration Postgres (`packages/db`, `0004_candidate_start_times.sql`) : `BookingRule.sessionStartTime` (string) → `candidateStartTimes` (jsonb liste) sur `booking_rules` et `job_runs`, migration des données existantes vers une liste à un seul élément (`to_jsonb(ARRAY[...])`), seed (`booking-rules.seed.json`) mis à jour
- [x] `sendPoll.ts`/`pollQuestion.ts` : construit la question et les options du sondage à partir de `candidateStartTimes` (+ option "Non" explicite) — question fermée classique si une seule heure, ouverte si plusieurs
- [x] `state.ts` : `PipelineStateType.confirmedPlayerIdsByTime` (regroupement par heure) et `bookingPlanGroups: BookingPlanGroup[]` (un plan par heure) remplacent `confirmedPlayerIds`/`bookingPlan`
- [x] `resolveVotes.ts`/`collectVotes.ts` : regroupent les joueurs confirmés par heure choisie (`statut` = libellé exact de l'heure votée, huddle-bot ADR-011)
- [x] `buildBookingParams.ts` : construit un `PlanGroupBookingsParams` par groupe d'heure, avec `startTime`/`maxCourts`/`preferMinPlayersPerCourt`/`courtPriority` de la `BookingRule` — ces champs deviennent enfin actionnables
- [x] `bookSlots.ts` : boucle sur `candidateStartTimes`, un appel `plan_group_bookings` par heure ayant assez de joueurs confirmés, agrège en `bookingPlanGroups`
- [x] `announce.ts` : fusionne les `proposedBookings` de tous les groupes d'heure avant `mergeContiguousSlotsByCourt` (un seul message WhatsApp final, `slotMerge.ts` inchangé — déjà générique)
- [x] `test:graph` : scénario mock étendu à 2 heures candidates (18H45, 19H30) avec des joueurs différents par heure — valide aussi qu'un groupe sous-effectif (1 joueur) devient réservable après `triggerRecollectVotes`
- [x] `triggerRecollectVotes`/`scheduler.ts` : `confirmedPlayerIdsByTime` mis à jour par `updateState`, cohérent par heure après relecture — validé par `test:graph`
- [x] `RuleForm.tsx`/`actions.ts`/`http/server.ts` : édition des heures candidates en CSV (règle et par job), cohérent avec `priorityBookers`/`courtPriority`

Typecheck + build Next.js + suite de tests (16 tests) + `test:graph` tous verts.

## Phase 4 — UI (`Pipeline.tsx`)

- [x] Étape 1 (Sondage) : affiche les heures candidates (édition CSV avant envoi, résumé après envoi)
- [x] Étape 2 (Collecte des votes) : liste les confirmés par heure (`confirmedPlayerIdsByTime`) ; le tally live (`pollTally`) affiche déjà le libellé exact voté par personne (huddle-bot renvoie l'option réelle, pas juste oui/non)
- [x] Étape 3 (Plan de réservation) : détail par groupe d'heure (courts, joueurs, avertissements) au lieu d'un seul plan plat
- [x] Étape 4 (Confirmation & Annonce) : liste le plan groupé par heure avant confirmation, affiche le message WhatsApp réellement envoyé (livré indépendamment plus tôt)

---

## Points ouverts

- [ ] Un participant peut-il choisir plusieurs heures (dispo aux deux), ou un choix unique par sondage (`allowMultiple: false` actuellement) ? À trancher en Phase 1.
- [ ] Rétrocompatibilité de `plan_group_bookings` : l'agent OpenClaw (qui consomme aussi ce tool) doit-il être mis à jour en même temps, ou le fallback sur `recurringStartTime`/`recurringWeekday` suffit-il à ne rien casser côté OpenClaw ? À vérifier en Phase 2.
- [ ] Format exact de `candidateStartTimes` dans `BookingRule` (liste de strings simples, ou objets avec un label/libellé pour le sondage) — à trancher en Phase 3.
