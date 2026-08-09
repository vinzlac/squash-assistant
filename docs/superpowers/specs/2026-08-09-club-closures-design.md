# Design — Fermetures PUC (intervalles globaux)

**Date** : 2026-08-09  
**Statut** : validated (brainstorming)  
**Approche** : table `club_closures` + check SendPoll + section admin `/settings`

## Problème

Certains jours / plages horaires, les courts PUC sont fermés. Aujourd’hui le pipeline envoie quand même le sondage WhatsApp pour la `targetDate`. Il faut pouvoir déclarer des fermetures globales et adapter SendPoll.

## Objectifs

1. Admin peut **ajouter / supprimer** des intervalles de fermeture (date+heure → date+heure), **globaux** pour tout le club.
2. Au SendPoll : si **aucune** heure candidate n’est jouable → message WhatsApp à la place du sondage, job arrêté.
3. Si **certaines** heures restent ouvertes → sondage filtré + mention des heures fermées dans la question.
4. Documenter la règle dans `docs/spec/regles-fonctionnelles.md` à l’implémentation.

## Non-objectifs (MVP)

- Calendrier automatique des jours fériés France.
- Fermetures par `BookingRule` / par groupe.
- Recalcul d’un job déjà passé SendPoll si une fermeture est ajoutée après coup.
- Modification TeamR / resa-squash / huddle-bot (hors `send_message` / `ask_poll` déjà utilisés).

## Données

### Table `club_closures`

| Colonne | Type | Notes |
|---------|------|--------|
| `id` | uuid PK | |
| `starts_at` | timestamptz | début inclus |
| `ends_at` | timestamptz | fin **exclusive** |
| `label` | text nullable | ex. « 15 août » |
| `created_at` | timestamptz | default now |

Contraintes : `ends_at > starts_at`. Pas de FK vers `booking_rules`.

Timezone d’interprétation UI et matching : **Europe/Paris** (aligné sur `pollQuestion.ts`).

### Matching

Pour une heure candidate `"18H45"` et `targetDate` `YYYY-MM-DD` :

- Instant = `YYYY-MM-DD 18:45` en Europe/Paris.
- Fermée ssi ∃ intervalle tel que `starts_at ≤ instant < ends_at`.

## Comportement pipeline

Point d’insertion : début du nœud **SendPoll** (cron ou trigger manuel), avant `ask_poll`.

1. Charger les fermetures qui peuvent chevaucher `targetDate` (filtre SQL large sur la journée Paris + marge, ou charge des intervalles actifs autour de la date).
2. Partitionner `candidateStartTimes` → `openTimes` / `closedTimes`.

### Cas A — `openTimes` vide

- Envoyer un message WhatsApp texte (pas un sondage), groupe de la règle :  
  `puc fermé <jour> <date> pas de squash`  
  Exemple : `puc fermé mardi 15 août pas de squash`  
  (réutiliser le formatage date informel existant : weekday + day + month, fr-FR / Paris).
- Log Telegram : `[ruleId] PUC fermé le … — job arrêté (pas de sondage)`.
- Émettre un event type **`club-closed`** (détail : message, `closedTimes`, `targetDate`) pour l’historique UI.
- **Ne pas** poser `pollRequestId`.
- Poser un flag d’état graphe **`clubClosed: true`** (champ dédié dans `PipelineState`) pour que `computeStage` puisse distinguer ce terminal de `not-started` (aujourd’hui `!pollRequestId` ⇒ `not-started`).
- Stage terminal nouveau : **`finished-club-closed`** (`computeStage` : si `values.clubClosed` ⇒ ce stage, avant le test `pollRequestId`).
- Après SendPoll cas A : arête conditionnelle vers **END** (ne pas enchaîner `waitForDecisionWindow`). Cas B/C : arête inchangée vers `waitForDecisionWindow`.
- Crons / triggers suivants : traiter `finished-club-closed` comme les autres stages terminaux (skip CollectVotes / plan / go).

### Cas B — `openTimes` non vide et `closedTimes` non vide

- `ask_poll` uniquement avec `openTimes` (+ options « Non » / prête-nom volontaire inchangées).
- Question : mentionner les heures fermées, ex.  
  `Squash mardi 15 août, à quelle heure : 19h30 ? (18h45 : puc fermé)`  
  (adapter le singulier/pluriel et le format heures comme `buildPollQuestion` / `formatSessionTime`).
- Suite du pipeline inchangée, en ne raisonnant qu’avec les heures effectivement proposées dans le sondage.
- Log Telegram optionnel : indiquer le filtre (heures retirées).

### Cas C — `closedTimes` vide

- Comportement actuel inchangé.

### Stage & UI job

Étendre `PipelineStage` (worker + UI) avec `finished-club-closed` :

- Étape 1 (Sondage) : `done` (message de fermeture envoyé à la place du sondage).
- Étapes 2–4 : non démarrées / N/A.
- Libellé : « PUC fermé — pas de squash ».
- Inclure ce stage dans les stages terminaux (pas de re-trigger CollectVotes / plan / go).

## UI admin

Section **« Fermetures PUC »** sur `/settings` :

- Liste des intervalles (début → fin, label), tri `starts_at` asc.
- Formulaire admin : datetime début, datetime fin, label optionnel → Ajouter.
- Bouton Supprimer par ligne.
- Lecture seule si non-admin ; écriture réservée au groupe Authentik `squash-admins` (même pattern que les groupes WhatsApp visibles).
- Validation serveur : `ends_at > starts_at` ; saisie interprétée en Europe/Paris.

API / actions : server actions Next.js (ou routes existantes worker si déjà le pattern pour settings) — suivre le pattern `saveVisibleGroupsAction` / accès DB depuis l’UI via `@squash-assistant/db`.

## Architecture (unités)

| Unité | Rôle |
|-------|------|
| `packages/db` | schéma + migration `club_closures` |
| `filterCandidateTimesByClosures` (worker, pur) | partition open/closed ; testable sans MCP |
| `buildClubClosedMessage` / extension `buildPollQuestion` | textes WhatsApp |
| `sendPoll` node | branche A/B/C |
| `computeStage` / UI Pipeline | stage `finished-club-closed` |
| `/settings` + actions | CRUD admin |

## Tests

- Unitaire matching : intervalle journée, demi-journée, borne exclusive `ends_at`, plusieurs intervalles, heure pile sur borne.
- Unitaire textes : message fermeture totale ; question sondage partiel.
- SendPoll (mocks) : cas A → `send_message` + pas `ask_poll` + stage terminal ; cas B → `ask_poll` avec sous-ensemble ; cas C → inchangé.

## Spécification fonctionnelle

À l’implémentation, ajouter une section dans `docs/spec/regles-fonctionnelles.md` décrivant fermetures globales, filtrage SendPoll, message et stage `finished-club-closed`. Pas d’ADR sauf si un choix d’archi non trivial émerge (la table dédiée vs JSON settings est déjà tranchée ici).
