# Design — Simulateur de scénarios de réservation

**Statut** : en attente de revue utilisateur avant passage en plan d'implémentation.
**Contexte** : le moteur d'allocation (`apps/worker/src/planning/`, ADR-018) est désormais local et testable, mais chaque ajustement de règle métier (continuité de court, plafond de résas/jour — voir corrections du 2026-08-01) n'a été validé jusqu'ici qu'en écrivant des tests unitaires à la main, ou en observant le comportement réel en production. Il n'existe aucun outil permettant de vérifier visuellement, pour une règle donnée, "si tel joueur répond oui à telle heure et tel autre prête son nom, est-ce que le plan produit est bien celui que j'attends ?" avant de déployer un changement. Ce projet ajoute un simulateur dans l'UI d'administration pour combler ce trou, avec un chemin d'export vers une suite de tests de non-régression versionnée.

## 1. Portée

**Fait dans ce projet** :
- Une nouvelle section de l'UI d'administration (`apps/ui`) associée à chaque règle (`BookingRule`), permettant de créer, éditer, dupliquer et supprimer des **scénarios** : un jeu de joueurs avec leur vote (heure candidate / "prête mon nom" / "non"), plus un calcul de plan de réservation basé sur le **vrai moteur local** (`computeGroupBookingPlan`), avec une disponibilité de courts synthétique où tout est libre.
- Un statut de validation par scénario (OK / pas OK / non évalué), posé manuellement par l'utilisateur après lecture du plan calculé.
- Un verrouillage : une règle référencée par au moins un scénario ne peut plus être modifiée (il faut d'abord supprimer le(s) scénario(s)).
- Un export (téléchargement JSON) des scénarios validés OK, destiné à être déposé manuellement dans une suite de tests de non-régression versionnée côté `apps/worker`.

**Explicitement hors périmètre** :
- Aucun appel MCP réel (ni huddle-bot, ni resa-squash) au moment du calcul du plan simulé — seule la liste des membres du groupe (`getGroupMemberNames`, déjà utilisée ailleurs dans l'UI) est lue depuis resa-squash, au moment de l'édition du scénario (pas à chaque calcul).
- Pas de simulation du plafond de résas/jour avec un compteur de départ non nul : chaque scénario démarre avec un compteur à zéro pour tous les joueurs (voir §3). Seul le dépassement **au sein même du scénario** (plusieurs rounds sur une heure candidate) peut déclencher une substitution.
- Pas d'automatisation de l'export (pas d'écriture directe dans le repo git depuis un pod K8s — l'UI et le worker tournent sans checkout du repo). L'export est un téléchargement, le dépôt dans le repo et le commit restent un geste manuel.
- Pas de édition des champs de règle depuis le simulateur : la règle est lue en lecture seule, seuls les joueurs/votes du scénario sont éditables (rappel explicite de l'utilisateur).
- Pas de gestion multi-utilisateurs/permissions sur les scénarios (cohérent avec ADR-009 : pas d'auth applicative, LAN-only).

## 2. Modèle de données

Nouvelle table `scenarios` (`packages/db/src/schema.ts`), sur le même modèle que `booking_rules`/`job_runs` :

```ts
export const scenarios = pgTable("scenarios", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingRuleId: text("booking_rule_id").notNull().references(() => bookingRules.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Un vote par joueur choisi : une heure candidate de la règle, "prete-nom", ou "non" (mutuellement exclusif). */
  players: jsonb("players").notNull().default([]).$type<ScenarioPlayer[]>(),
  /** userId du joueur jouant le rôle du titulaire de la clé API (exempté de plafond) — null si aucun. */
  apiUserId: text("api_user_id"),
  /** null = non évalué, true = plan OK, false = plan pas OK (ne doit pas être exporté). */
  validated: boolean("validated"),
  /** Dernier plan calculé (bookingPlanGroups), pour affichage sans recalcul à l'ouverture du scénario. */
  lastPlan: jsonb("last_plan"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdateFn(() => new Date()),
});

export interface ScenarioPlayer {
  playerId: string; // userId resa-squash
  name: string;      // dénormalisé au moment de l'ajout, pour affichage sans re-résolution
  vote: string;       // une valeur de bookingRule.candidateStartTimes, ou "prete-nom", ou "non"
}
```

`ON DELETE CASCADE` sur `bookingRuleId` : supprimer une règle supprime ses scénarios (cohérent avec `job_runs`/`booking_rule_history`).

## 3. Calcul du plan simulé

Nouveau module pur `apps/worker/src/planning/simulateScenario.ts`, qui réutilise **sans le dupliquer** le moteur existant :

**Entrée** : `BookingRule` (lecture seule) + `ScenarioPlayer[]` + `apiUserId: string | null`.

**Étapes** :
1. **Disponibilité synthétique** — génère un `AvailableSlot[]` couvrant, pour chaque heure candidate de la règle, `rule.maxReservationsPerPlayer` créneaux de 45 min consécutifs, sur `SQUASH_COURT_COUNT` courts (constante déjà définie dans `planning/constants.ts`), tous marqués disponibles. Aucun appel `list_availability`.
2. **Dérivation des votes** — reproduit exactement la sémantique de `resolveVotes.ts` (un seul vote par joueur) sans passer par un sondage réel :
   - `confirmedPlayerIdsByTime: Record<heure, userId[]>` — un joueur dont le vote est une heure candidate y est ajouté.
   - `volunteerSubstituteIds: string[]` — joueurs dont le vote est `"prete-nom"`.
   - Les votes `"non"` n'apparaissent nulle part (identique à un "non"/"ambigu"/absence de réponse réel).
3. **Boucle par heure candidate** — appelle la même boucle que `bookSlots.ts` (`usedSessionIds`, `existingDailyCounts`, `usedTodayIds` threadés d'heure en heure, `apiUserId` transmis tel quel), extraite dans un nouveau module partagé `apps/worker/src/planning/planJob.ts` (fonction pure, ex. `planJobBookings(rule, confirmedPlayerIdsByTime, volunteerSubstituteIds, availableSlots, apiUserId)` → `BookingPlanGroup[]`). `bookSlots.ts` (nœud réel) et `simulateScenario.ts` appellent tous les deux `planJobBookings` — seuls diffèrent l'origine de `availableSlots` (réel via `list_availability` / synthétique) et les effets de bord autour (Telegram, event logging, écriture DB), qui restent dans `bookSlots.ts`. Aucun MCP, aucun Telegram, aucune écriture DB de job/event côté simulateur.

**Pourquoi pas une copie du moteur** : la valeur du simulateur dépend entièrement du fait qu'il exerce le code réellement déployé. Toute divergence (même mineure) invaliderait son usage comme outil de décision — d'où l'extraction de `planJobBookings`, refactor à comportement inchangé de `bookSlots.ts`, couvert par les tests `bookSlots.test.ts` existants (décision validée le 2026-08-01).

**Exposition** : nouvel endpoint HTTP interne du worker `POST /rules/:id/scenarios/:scenarioId/simulate` (même pattern que `/rules/:id/jobs/:jobId/trigger/:action`), appelé par l'UI via `apps/ui/src/lib/worker.ts`. Le résultat est stocké dans `scenarios.lastPlan` (permet de rouvrir un scénario sans recalcul).

## 4. UX — CRUD des scénarios

- **Liste** (`/rules/[id]/simulator`) : tableau des scénarios de la règle — nom, statut (badge OK / pas OK / non évalué), date de dernière modification. Actions : Créer, Dupliquer, Supprimer (avec confirmation, cohérent avec le reste de l'UI — pas de `window.confirm` qui bloquerait l'extension Chrome, un vrai bouton de confirmation inline).
- **Édition** (`/rules/[id]/simulator/[scenarioId]`) :
  - En-tête rappelant la règle associée (lecture seule, lien vers la page règle).
  - Sélecteur de joueurs : liste des membres réels du groupe resa-squash (`getGroupMemberNames`), chacun avec un menu déroulant de vote (heures candidates de la règle + "Prête mon nom" + "Non"), défaut "Non".
  - Sélection du titulaire (optionnelle) : un seul joueur du scénario peut être marqué "titulaire (exempté de plafond)".
  - Bouton "Calculer le plan" → appelle l'endpoint de simulation, affiche le résultat avec le **même composant de rendu** que l'étape 3 du pipeline réel (réutilisation, pas de duplication d'affichage).
  - Boutons "Valider (OK)" / "Invalider (pas OK)" (posent `validated`), "Sauvegarder", "Supprimer".
  - Bouton "Exporter" visible seulement si `validated === true` (voir §5).

## 5. Verrouillage de la règle référencée

Défense en profondeur (deux couches, pas une seule) :
- **UI** : sur la page d'édition d'une règle (`/rules/[id]/edit`), si des scénarios existent pour cette règle, le formulaire d'édition est remplacé par un message explicite ("Cette règle est utilisée par N scénario(s) de simulation — supprime-les d'abord pour la modifier") avec la liste des scénarios concernés en lien.
- **Serveur** : l'action de sauvegarde de règle (`apps/ui/src/app/actions.ts`) vérifie l'existence de scénarios référençant `bookingRuleId` avant tout `UPDATE` et lève une erreur explicite sinon (remonte via `error.tsx`, cf. le fix du 2026-08-01) — protège contre un appel direct de l'action qui contournerait l'UI.

La création d'une nouvelle règle et la désactivation (`enabled`) restent possibles sans restriction — seule la modification des champs de règle est bloquée.

## 6. Export vers non-régression

- Le bouton "Exporter" télécharge un fichier JSON :
  ```json
  {
    "scenario": { "name": "...", "players": [...], "apiUserId": "..." },
    "rule": { "candidateStartTimes": [...], "maxReservationsPerPlayer": ..., "maxCourtsPerSlot": ..., "preferMinPlayersPerCourt": ..., "courtPriority": [...], "maxDailyReservationsPerPlayer": ..., "substituteBookers": [...] },
    "expectedPlan": { "bookingPlanGroups": [...] }
  }
  ```
  (uniquement les champs de `BookingRule` réellement consommés par `computeGroupBookingPlan`/`simulateScenario` — pas tout l'objet règle).
- L'utilisateur dépose ce fichier dans `apps/worker/src/planning/__fixtures__/scenarios/<slug>.json` et le commit.
- Nouveau test `apps/worker/src/planning/scenarios.regression.test.ts` : parcourt tous les fichiers de ce dossier au moment de l'exécution des tests (`fs.readdirSync`), rejoue `simulateScenario` avec les mêmes entrées, et vérifie une égalité stricte (`toEqual`) avec `expectedPlan`. Un scénario cassé par une évolution du moteur fait échouer la suite `npm test` normale — pas besoin de commande séparée.

## 7. Décisions et points mécaniques restants

1. **Extraction de la boucle candidate-heure — tranché (2026-08-01)** : nouveau module `apps/worker/src/planning/planJob.ts` exportant `planJobBookings` (boucle + threading `usedSessionIds`/`existingDailyCounts`/`usedTodayIds`), appelé à la fois par `bookSlots.ts` (nœud réel, garde ses effets de bord) et `simulateScenario.ts`. Refactor à comportement inchangé, couvert par `bookSlots.test.ts` existant.
2. **Emplacement exact de l'endpoint de simulation** : ajouter une route au serveur HTTP interne existant du worker (`apps/worker/src/http/server.ts`) suivant le pattern déjà en place pour `/rules/:id/jobs/:jobId/trigger/:action` — mécanique, pas d'arbitrage nécessaire.
3. **Format exact du composant de rendu partagé** entre l'étape 3 du pipeline réel et l'affichage du plan simulé — à identifier précisément dans `Pipeline.tsx` au moment du plan (probablement extractible en composant `PlanDisplay` autonome).
