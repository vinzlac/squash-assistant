# Spécification fonctionnelle — squash-assistant

**Statut** : document vivant, mis à jour à chaque fois qu'une règle métier est décidée ou change. Sert de référence unique pour "qu'est-ce que le produit doit faire" — à consulter avant d'implémenter ou de modifier une règle, et à mettre à jour dans la même PR que le changement de comportement.

Ce document décrit le **comportement fonctionnel** (règles métier, comportement UI, règles d'affichage). Pour :
- le **contexte/vision** et les systèmes externes (MCP huddle-bot/resa-squash, Telegram) → [`docs/plan/squash-assistant-poc.md`](../plan/squash-assistant-poc.md)
- les **décisions d'architecture** (pourquoi tel choix technique) → [`docs/adr/`](../adr/README.md)

---

## 1. Vue d'ensemble du pipeline

Un **job** = une exécution hebdomadaire du pipeline pour une `BookingRule` donnée. Le pipeline a 4 étapes séquentielles, chacune avec un état visible dans l'UI (`not-started` / `current` / `done` / `error`) :

1. **Sondage** (SendPoll) — envoie un sondage WhatsApp multi-choix ("qui joue le {date} ?", une option par heure candidate) + log Telegram.
2. **Collecte des votes** (CollectVotes) — lit les réponses WhatsApp (déjà classifiées côté huddle-bot), résout les joueurs par heure candidate + log Telegram.
3. **Plan de réservation** (BookSlots, dry-run) — calcule un plan de réservation par heure ayant des joueurs confirmés + log Telegram.
4. **Réservation et annonce** (Announce) — attend un "go" humain, réserve (dry-run par défaut), annonce sur WhatsApp en regroupant les créneaux adjacents + log Telegram.

Chaque étape logue son résultat sur Telegram (canal de supervision), qu'elle réussisse, échoue, ou soit en attente de confirmation.

Terminologie retenue : **"étape"** (pas "tâche" / "step" en anglais dans l'UI) pour désigner chacun des 4 blocs du pipeline.

---

## 2. Étape 1 — Sondage

- Une `BookingRule` a une `targetDate` (date réservée) et des `candidateStartTimes: string[]` (une ou plusieurs heures candidates, ex. `["18H45", "19H30"]`) — éditables tant que le job est `not-started`.
- Le formulaire d'édition (date + heures candidates) et le bouton de lancement du sondage sont **dans le même `<form>`**, avec deux boutons distincts (`formAction` différent) :
  - **"Mettre à jour"** → sauvegarde seule (`editJobAction`), le job reste `not-started`.
  - **"Enregistrer et lancer le sondage"** → sauvegarde **puis** lance le sondage (`triggerSendPollAction` appelle `editJob` avant de déclencher l'envoi), pour ne jamais perdre une modification faite juste avant de lancer.
- Une fois le sondage envoyé (`awaiting-decision`), il peut être annulé (`cancelPollAction`) tant qu'aucun vote n'a été collecté — supprime le message de sondage WhatsApp.
- Le libellé du sondage WhatsApp inclut la date cible et la liste des heures candidates (`buildPollQuestionPreview`).

## 3. Étape 2 — Collecte des votes

- "Lire les réponses et les interpréter" fige les votes actuels du sondage WhatsApp et résout les `userId` resa-squash par heure votée → `confirmedPlayerIdsByTime: Record<heure, userId[]>`.
- Avant collecte, l'UI affiche en aperçu qui a déjà répondu et quoi (`pollTally`), avec un lien pour rafraîchir sans quitter la page.
- Une fois à l'étape `awaiting-plan`, il reste possible de **relire les réponses** ("Relire les réponses (nouveau vote / vote changé)") pour prendre en compte un vote arrivé ou changé après la première collecte.
- Affichage : nombre de joueurs confirmés par heure. Les noms des joueurs ne sont **pas** résolus à cette étape dans l'UI (seuls les `userId` sont connus côté état) ; la résolution nom↔`userId` n'intervient qu'à l'affichage des étapes 3/4 (voir §6).

## 4. Étape 3 — Plan de réservation

- "Calculer le plan" déclenche, **pour chaque heure candidate ayant au moins un joueur confirmé**, un appel `plan_group_bookings` en dry-run (`dryRun: true` toujours à ce stade) → produit un `bookingPlanGroups: Array<{ startTime, plan: { proposedBookings, warnings } }>`.
- **Règle d'affichage (2026-07-19)** : la liste affichée dans l'UI ne montre **que les heures candidates ayant réellement eu au moins un vote confirmé** — qu'un plan en soit résulté (`proposedBookings` non vide) ou que le plan ait échoué (effectif insuffisant, `warnings` non vide). Une heure candidate n'ayant reçu **aucun** vote est masquée : ce n'est pas un échec à afficher, juste une option que personne n'a choisie.
  - Si **aucune** heure candidate votée n'a de créneau jouable, affiche un message générique explicite : *"— Aucun créneau possible (aucune heure votée n'a de joueur confirmé)."*
  - Rationale : une heure à 0 votes affichée comme "échec (0/2 requis)" est indiscernable visuellement d'un vrai échec par effectif insuffisant, et n'apporte aucune information utile.
- Chaque ligne de réservation proposée affiche le court, l'horaire réel du créneau (`slotTime`–`slotEndTime` — peut différer de l'heure candidate votée, ex. 2e manche via `maxReservationsPerPlayer`), et les joueurs concernés (noms, voir §6).
- Le détail brut (`<details>` "détail") garde les `userId` bruts, pas les noms (voir §6).
- **Continuité de court sur créneaux successifs (règle 2026-07-21, implémentée côté resa-squash)** : quand une même paire de joueurs occupe 2 créneaux de 45 min qui se suivent (ex. `maxReservationsPerPlayer=2`), le plan doit **privilégier le même court sur les 2 créneaux**, plutôt que d'appliquer `courtPriority` indépendamment à chaque créneau.
  - D'abord vérifier les courts réellement disponibles sur chacun des créneaux planifiés, puis choisir parmi ces disponibilités selon l'ordre `courtPriority` défini dans la `BookingRule` du groupe.
  - Si un court est disponible sur les 2 créneaux successifs, il est préféré à un court mieux classé dans `courtPriority` mais disponible sur un seul des 2 — l'objectif est d'éviter à la paire de changer de court en cours de session.
  - Exemple : `courtPriority=[4,3,2,1]`, le court 4 n'est libre que sur le 1er des 2 créneaux, le court 3 sur les 2 → le plan retient le court 3 sur les 2 créneaux, pas le court 4.
  - Seulement si **aucun** court n'est commun aux 2 créneaux, le plan se rabat sur des courts différents pour chaque créneau, choisis indépendamment selon `courtPriority`.
  - Cette règle est implémentée dans `resa-squash` (`plan_group_bookings` / `resolveCourtAssignments` dans `group-booking-plan.ts`), pas dans squash-assistant — voir [ADR-009 resa-squash](../../../resa-squash/docs/adr/009-continuite-court-creneaux-successifs.md) (repo séparé) et [ADR-008 resa-squash](../../../resa-squash/docs/adr/008-plan-group-bookings-parametres-strategie.md) pour `courtPriority`. squash-assistant reste responsable de fournir `courtPriority` (champ `BookingRule.courtPriority`) sans réimplémenter l'allocation.
- **Escalade automatique min→max joueurs/court, alerte de capacité, fenêtre de disponibilité (règle 2026-07-22, ADR-014)** : avant de figer le plan d'une heure candidate, squash-assistant vérifie que la capacité des courts suffit pour tous les joueurs confirmés.
  - 1er appel `plan_group_bookings` avec le remplissage configuré sur la règle (`preferMinPlayersPerCourt`). Si le nombre de réservations obtenues est inférieur à l'objectif (paires × `maxReservationsPerPlayer`) **et** que la règle est en remplissage min, un **2e appel** est fait en remplissage max (`preferMinPlayersPerCourt: false`, jusqu'à `maxPlayersPerCourt`) — le meilleur des deux résultats est retenu.
  - Si la capacité manque encore après escalade, un message Telegram d'alerte est envoyé **avant même l'affichage du plan** (dans le même message, en tête) : "⚠️ {heure} : capacité des courts insuffisante — ~N joueur(s) risquent de ne pas avoir de créneau."
  - **Fenêtre de disponibilité** (`availabilityWindowHours`, nouveau champ de la `BookingRule`, défaut 3h) : `plan_group_bookings` peut proposer des créneaux avançant naturellement dans la journée si les courts manquent à l'heure votée (aucun changement resa-squash requis, cf. ADR-014) ; squash-assistant compare l'horaire réel de chaque réservation proposée à `heure votée + availabilityWindowHours` — celles qui dépassent sont marquées **hors fenêtre** (`outOfWindowSessionIds`) : affichées à l'étape 3 (avec la mention "hors fenêtre, non réservé") mais **jamais réservées** (exclues de `reserve_slot` à l'étape 4) ni annoncées sur WhatsApp.
  - Ces règles sont entièrement dans squash-assistant (`bookSlots.ts`, `capacityPlanning.ts`) — aucun changement d'API resa-squash.

## 5. Étape 4 — Réservation et annonce

*(Anciennement "Confirmation & Annonce" — renommée le 2026-07-22 car cette étape fait aussi la réservation réelle, cf. ADR-014.)*

- Une fois le plan calculé (`awaiting-go`), l'UI réaffiche le plan proposé (uniquement les heures ayant produit des réservations dans la fenêtre acceptée, `proposedBookings.length > 0` moins les créneaux hors fenêtre — les échecs restent visibles à l'étape 3) et présente le formulaire de confirmation.
- **Dry-run (case à cocher, cochée par défaut)** : détermine si la confirmation déclenche de vraies réservations (`reserve_slot`) ou reste en simulation.
  - Cochée (défaut) → `dryRun: true`, aucune vraie réservation.
  - Décochée → `realBooking: true` transmis au worker, qui appelle réellement `reserve_slot` pour chaque ligne du plan, **séquentiellement**, avec **rollback best-effort** (`cancel_reservation` sur les réservations déjà faites) si un appel échoue en cours de route.
- **"Valider le go dans Telegram" (case à cocher)** : force l'attente d'un message "go" explicite sur le bot Telegram dédié, au lieu de considérer le clic sur le bouton de confirmation UI comme suffisant.
  - Non cochée (défaut) → cliquer sur le bouton de confirmation dans l'UI vaut confirmation immédiate.
  - Cochée → le pipeline reste en pause jusqu'à réception d'un message Telegram contenant "go" (polling `getUpdates`, jusqu'à 4h d'attente avant expiration) ; le clic UI seul ne suffit plus.
  - Ces deux cases sont indépendantes : on peut valider en dry-run avec ou sans passer par Telegram, et de même pour une vraie réservation.
- Le message Telegram envoyé à cette étape précise explicitement qu'il attend un "go" pour continuer le traitement.
- **Regroupement des créneaux adjacents** : règle de **présentation uniquement** du message WhatsApp final ("Court 2 : 18h45–20h15" au lieu de deux lignes séparées) — ne change rien à la réservation elle-même, qui reste **unitaire** (un appel `reserve_slot` par créneau de 45 min). Algorithme porté depuis `resa-squash` (`slot-merge.ts`).
- **Message de sursaturation (2026-07-22, ADR-014)** : si des joueurs confirmés n'ont pas pu être réservés (capacité insuffisante même après escalade, et/ou créneaux hors fenêtre exclus), le message WhatsApp final ajoute une ligne explicite : *"⚠️ N joueur(s) n'ont pas pu être réservé(s) — capacité des courts dépassée."*
- États terminaux : `finished-announced` (confirmé + annoncé, message WhatsApp affiché dans l'UI), `finished-cancelled` (pas de confirmation reçue), `finished-no-plan` (rien à confirmer, aucun créneau proposé à l'étape 3).

## 6. Règles transverses

- **Noms vs identifiants** : partout dans l'UI où un joueur est affiché de façon "lisible" (résumé des étapes 3 et 4), on affiche son **nom** (`playerNames[userId] ?? userId`, résolu via `list_group_members` resa-squash), jamais son `userId` brut. Le **détail JSON brut** (`<details>` "détail") garde volontairement les `userId` — utile pour le debug, pas pour la lecture rapide. Même principe sur la page d'édition d'une règle (`/rules/[id]/edit`) : le libellé du groupe WhatsApp (`list_groups` huddle-bot) et du groupe resa-squash (`list_my_groups`) s'affiche à côté de leurs identifiants bruts, et un tableau userId→nom (`list_group_members`) accompagne le champ "Réservataires prioritaires" — les champs eux-mêmes restent des IDs stockés en base, l'affichage lisible est purement informatif.
- **Boutons d'action** : tout bouton déclenchant une action doit passer en `disabled` pendant que l'action est en cours (`useFormStatus` + `SubmitButton`), pour éviter les double-déclenchements.
- **Thème** : l'app est volontairement **light-only** (`color-scheme: light` explicite) — pas de support dark mode. Laisser `color-scheme: light dark` fait que les navigateurs en thème sombre système appliquent leurs styles natifs sombres aux `<input>`/`<button>` par-dessus le CSS clair codé en dur, rendant certains boutons illisibles.
- **Confirmation humaine avant écriture** : aucune action irréversible (vraie réservation `reserve_slot`) ne doit jamais se déclencher sans un "go" explicite (UI ou Telegram selon la case à cocher, §5) — c'est la seule porte d'écriture réelle de tout le pipeline.
- **Snapshot de la règle par job (2026-07-22, ADR-014)** : chaque job garde une copie figée (`jobRuns.ruleSnapshot`) de la `BookingRule` telle qu'elle était à sa création — traçabilité si la règle est éditée après coup (ex. `courtPriority`, `candidateStartTimes`), visible dans le détail du job.
- **Historique complet des règles (2026-07-22, ADR-014 addendum)** : indépendamment du snapshot par job ci-dessus, chaque sauvegarde d'une règle (création, édition, activation/désactivation) enregistre une ligne dans `booking_rule_history` (copie complète + horodatage) — consultable sur `/rules/[id]/history` (lien "Historique de la règle" depuis la page d'édition). Pas de calcul de diff entre versions, juste des captures complètes à comparer manuellement.
- **Nom de règle + navigation (2026-07-22)** : `BookingRule.name` (optionnel) est un libellé lisible affiché à la place de l'`id` partout où une règle est listée (home, page groupe, titres de job/historique) — repli sur l'`id` si absent ; l'`id` reste le slug technique (URL), jamais éditable après création. Navigation croisée ajoutée pour éviter les impasses : page de job → lien "Éditer la règle" ; page d'édition d'une règle → liens "Retour au groupe", "Nouvelle règle pour ce groupe", "Historique des jobs", "Historique de la règle" ; page d'édition affiche aussi `createdAt`/`updatedAt` de la règle.
- **Duplication de règle (2026-07-22)** : bouton "Dupliquer" (page groupe + page d'édition) → ouvre le formulaire de création pré-rempli avec tous les champs de la règle source (sauf `id`, laissé vide, et `enabled`, qui redémarre à `false`) ; le nom par défaut devient "{nom source} (copie)". Aucune règle n'est créée tant que le formulaire n'est pas soumis.
- **Description générée en français (2026-07-22)** : `describeRuleInFrench` (`packages/db/src/ruleDescription.ts`, testé indépendamment) produit une description exhaustive et déterministe (aucun appel LLM) de tous les paramètres d'une règle — affichée dans un `<details>` repliable sur la page d'édition.
- **Extraction LLM description → paramètres (2026-07-22, ADR-015)** : `extractRuleParamsFromDescription` (`apps/worker/src/llm/`, Anthropic Claude, tool-use forcé) fait le chemin inverse — pas encore branché à l'UI (pas de bouton "Générer" pour l'instant), validé par des tests d'intégration réels (`npm run test:llm`, hors CI, nécessite `ANTHROPIC_API_KEY`) sur les 3 règles réelles connues. Seule intégration LLM du projet, volontairement isolée de la logique du pipeline (aide à la saisie uniquement).

---

## Historique des décisions notables

| Date | Règle | Contexte |
|------|-------|----------|
| 2026-07-22 | Étape 3 : escalade min→max joueurs/court, fenêtre de disponibilité, alerte de capacité + renommage étape 4 ("Réservation et annonce") + snapshot de règle par job | Le plan ne vérifiait pas en amont si les courts suffisaient pour tous les confirmés ; rien ne tracait la version de règle utilisée par un job (ADR-014) |
| 2026-07-21 | Étape 4 : la case "Dry-run" est un state React contrôlé, pas `defaultChecked` | Une case non contrôlée, démontée/remontée à chaque bascule de "Valider le go dans Telegram", revenait silencieusement à "cochée" même après l'avoir décochée — un clic "vraie réservation" est resté en dry-run sans erreur visible |
| 2026-07-21 | Étape 3 : continuité de court sur 2 créneaux successifs d'une même paire, avant `courtPriority` | Éviter qu'une paire change de court en cours de session quand un court est disponible sur les 2 créneaux mais moins bien classé en priorité (implémenté côté resa-squash) |
| 2026-07-19 | Étape 3 : masquer les heures candidates sans aucun vote confirmé | Une heure à 0 vote s'affichait comme "échec (0/2 requis)", confusion avec un vrai échec par effectif insuffisant |
| 2026-07-18 | Étape 3/4 : afficher les noms des joueurs plutôt que le `userId` (détail JSON gardé en `userId`) | Lisibilité du plan de réservation |
| 2026-07-18 | Formulaire étape 1 fusionné en un seul `<form>` (édition + lancement du sondage) | Une modification de créneaux était perdue si on cliquait sur "Lancer le sondage" (formulaire séparé) |
| 2026-07-18 | `color-scheme: light` (pas `light dark`) | Bouton "Mettre à jour" illisible en thème sombre système |
| — | Case "dry-run" (cochée par défaut) à l'étape 4 | Sécurité : jamais de vraie réservation sans décision explicite de tester en réel |
| — | Case "valider le go dans Telegram" à l'étape 4 | Permettre d'exiger une confirmation passant explicitement par Telegram plutôt que le seul clic UI |
| — | Regroupement des créneaux adjacents = présentation uniquement (annonce WhatsApp) | La réservation reste unitaire par créneau de 45 min côté resa-squash |
| — | Offset `getUpdates` Telegram persisté en mémoire, mis à jour à chaque message consommé | Un message "go" resté dans le backlog Telegram était rejoué sur un job sans rapport (non acquitté) |
