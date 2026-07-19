# Plan — Sondage multi-créneaux horaires

**Date** : 2026-07-19
**Statut** : proposé, pas démarré
**Décision d'architecture** : voir [ADR-013](../adr/ADR-013-multi-creneaux-horaires-repartition-des-responsabilites.md) pour le contexte, les alternatives considérées et le contrat détaillé entre les 3 repos. Ce document ne fait que suivre la progression, phase par phase — pour le "pourquoi", se référer à l'ADR.

**Repos concernés** : `huddle-bot`, `resa-squash`, `squash-assistant` (ce repo). Chaque phase est livrable et testable indépendamment ; squash-assistant peut être développé avec des mocks (`test:graph`) avant l'intégration réelle avec les deux autres.

---

## Phase 1 — huddle-bot : sondage multi-choix natif

- [ ] Généraliser `ask_poll` : schéma MCP (`app/api/mcp/route.ts`) + `poll-requests.ts` pour accepter `options: string[]` au lieu de `POLL_OPTIONS` figé (`['Oui', 'Non']`)
- [ ] Thread `options` jusqu'à `wa.createPoll` (déjà générique côté Baileys — pas de changement attendu là)
- [ ] Élargir le type `Statut`/`PollResponse.statut` d'une union figée (`oui|non|ambigu|aucune_reponse`) à `string`
- [ ] Adapter `buildPollStatusMaps` pour renvoyer `option.name` (l'option réellement votée) au lieu de collapser vers oui/non
- [ ] Vérifier que `pollRequests.options` (déjà `jsonb`) n'a pas besoin de migration
- [ ] Test manuel bout en bout : sondage à 3 options réel sur le groupe de test WhatsApp, vérifier que `get_responses` renvoie bien l'option choisie par votant
- [ ] Documenter le changement dans un ADR côté huddle-bot

## Phase 2 — resa-squash : `plan_group_bookings` généralisé

- [ ] Ajouter au schéma zod du tool (`app/api/mcp/route.ts`) : `startTime` (requis ou optionnel avec fallback), `maxCourts`, `preferMinPlayersPerCourt`, `courtPriority`
- [ ] Adapter `group-booking-plan.ts` : remplacer le filtre `recurringStartTime` (plancher `>=`) par un filtre sur `startTime` exact
- [ ] Brancher `maxCourts` comme plafond du nombre de courts choisis par vague (`pickCourtsForWave`)
- [ ] Brancher `preferMinPlayersPerCourt` dans la logique de remplissage (aujourd'hui implicite)
- [ ] Utiliser `courtPriority` pour l'ordre de sélection des courts (au lieu d'un ordre arbitraire)
- [ ] Garder `recurringWeekday`/`recurringStartTime` du groupe en fallback si `startTime` n'est pas fourni (vérifier si l'agent OpenClaw existant utilise encore l'ancien contrat sans `startTime`)
- [ ] Étendre `group-booking-plan.test.ts` pour les nouveaux paramètres
- [ ] Documenter le changement de contrat dans un ADR côté resa-squash

## Phase 3 — squash-assistant : modèle + graphe LangGraph

- [ ] Migration Postgres (`packages/db`) : `BookingRule.sessionStartTime` (string) → `candidateStartTimes` (liste), migration des règles existantes (`squashacademie-mardi`, `test-vincent-all`, etc.) vers une liste à un seul élément
- [ ] `sendPoll.ts` : construire les options du sondage à partir de `candidateStartTimes`
- [ ] `state.ts` : adapter `PipelineStateType` (`confirmedPlayerIds` → regroupement par heure)
- [ ] `resolveVotes.ts`/`collectVotes.ts` : regrouper les joueurs confirmés par heure choisie (`confirmedPlayerIdsByTime: Record<string, string[]>`)
- [ ] `buildBookingParams.ts` : construire un `PlanGroupBookingsParams` par groupe d'heure (avec `startTime`/`maxCourts`/`preferMinPlayersPerCourt`/`courtPriority` de la `BookingRule`)
- [ ] `bookSlots.ts` : boucler sur les groupes d'heure, un appel `plan_group_bookings` par groupe, agréger les `proposedBookings`
- [ ] `announce.ts`/`slotMerge.ts` : fusionner l'annonce sur plusieurs groupes d'heure (actuellement une seule fusion de créneaux contigus)
- [ ] `test:graph` : étendre le scénario mock pour couvrir 2 heures candidates avec des joueurs différents par heure
- [ ] `triggerRecollectVotes` : vérifier que le regroupement par heure reste cohérent après une relecture des votes

## Phase 4 — UI (`Pipeline.tsx`)

- [ ] Étape 1 (Sondage) : afficher la ou les heures candidates, pas seulement la date
- [ ] Étape 2 (Collecte des votes) : lister qui a répondu oui à quelle heure, et qui a dit non/n'a pas répondu à aucune heure
- [ ] Étape 3 (Plan de réservation) : afficher le détail jour/heure/court/personnes par groupe d'heure (pas un seul plan plat)
- [x] Étape 4 (Confirmation & Annonce) : afficher le message WhatsApp réellement envoyé — **déjà livré**, indépendamment de ce chantier

---

## Points ouverts

- [ ] Un participant peut-il choisir plusieurs heures (dispo aux deux), ou un choix unique par sondage (`allowMultiple: false` actuellement) ? À trancher en Phase 1.
- [ ] Rétrocompatibilité de `plan_group_bookings` : l'agent OpenClaw (qui consomme aussi ce tool) doit-il être mis à jour en même temps, ou le fallback sur `recurringStartTime`/`recurringWeekday` suffit-il à ne rien casser côté OpenClaw ? À vérifier en Phase 2.
- [ ] Format exact de `candidateStartTimes` dans `BookingRule` (liste de strings simples, ou objets avec un label/libellé pour le sondage) — à trancher en Phase 3.
