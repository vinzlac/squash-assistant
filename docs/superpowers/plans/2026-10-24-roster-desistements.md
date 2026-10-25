# Sondage conservé et roster vivant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** garder le sondage WhatsApp votable jusqu'au premier créneau, et publier dans le groupe un roster vivant. Avant la réservation, c'est un roster provisoire ; après, il prend la place de l'annonce. Il est republié à chaque changement de vote, avec plafond, liste d'attente et remplacements.

**Architecture :**
- **Trois modules purs** dans `apps/worker/src/roster/`, sans I/O :
  - `voteLedger.ts` : photo de collecte + événements de vote → état des votes ;
  - `allocation.ts` : places, attente, remplacements ;
  - `rosterMessage.ts` : texte et empreinte.
- **Deux modules avec I/O** :
  - `rosterStore.ts` : colonnes `job_runs` et lecture de `whatsapp_resa_events` ;
  - `publishRoster.ts` : envoi, retrait de l'ancien, épinglage, orphelin.
- **Branchements** : CollectVotes, BookSlots, Announce, SendPoll, la fermeture PUC, l'annulation, la confirmation et le rappel. Un tick à la minute republie le roster. Les jobs dont le sondage annonçait sa clôture gardent l'ancien code, intact.

**Tech Stack :** TypeScript, Vitest, Drizzle (Postgres), LangGraph.js, MCP huddle-bot / resa-squash.

**Spec :** [`docs/superpowers/specs/2026-10-24-roster-desistements-design.md`](../specs/2026-10-24-roster-desistements-design.md) (validée le 2026-10-25, commit 7047577). **Besoin :** [`docs/besoins/2026-10-24-roster-desistements.md`](../../besoins/2026-10-24-roster-desistements.md).

## Global Constraints

- Les textes WhatsApp sont recopiés à l'identique depuis la spec :
  - pied du roster provisoire : `Les courts arrivent bientôt 😉` puis `Pour te désister, retire ton vote dans le sondage 🙏` ;
  - pied du roster définitif : `Changer d'heure = repasser en attente si l'heure est pleine.` puis `Pour te désister, retire ton vote dans le sondage 🙏` ;
  - provisoire sans inscrit : `📋 Inscrits — <date>` / `Personne pour l'instant 😢`.
- WhatsApp ≠ Telegram :
  - sur WhatsApp, ni id resa-squash, ni téléphone, ni JID : noms via `playerMessageName` et `publicVoterName` (`apps/worker/src/graph/nodes/registrationRecap.ts`) ;
  - sur Telegram, les détails techniques sont permis.
- Seuil de suppression « pour tous » : `POLL_DELETE_MAX_AGE_HOURS = 48` (`apps/worker/src/graph/nodes/pollQuestion.ts`), réutilisé, jamais redéfini. Durée d'épinglage `PIN_DURATION = "7d"` (`apps/worker/src/graph/pinning.ts`).
- Best-effort : tout ce qui suit un envoi WhatsApp réussi (épinglage, désépinglage, suppression, Telegram) ne fait jamais échouer une étape.
- Ordre de traitement des événements de vote : `created_at`, puis `event_id`. Jamais `occurredAt` pour l'ordre. `occurredAt` ne sert qu'à la règle de l'événement périmé.
- Clé d'un votant :
  - `tel:+<chiffres>` si un téléphone est connu ;
  - sinon `jid:<jid>` pour un événement ;
  - sinon `nom:<nom WhatsApp>` pour un votant de la photo.
- **Mode legacy.** Un job est en mode legacy si la question du sondage envoyé contient `réponses jusqu'au` (`pollAnnouncedClosure`), ou si `roster_photo` est nul après la collecte. Ce mode garde exactement le code actuel. Aucun test existant du mode legacy n'est modifié.
- Migration : générée par `drizzle-kit`, appliquée par l'initContainer (ADR-012). Ne jamais indiquer `db:migrate` comme étape manuelle.
- Après chaque tâche qui touche du code : `npm run typecheck` et les tests du workspace touché, réellement lancés. Un commit conventionnel par tâche, terminé par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Ancien job en vol au déploiement**, quand le sondage annonçait sa clôture : il doit garder la suppression, le récap et l'annonce classiques, sans roster. Test dans la tâche 8 (`collecte legacy inchangée si la question annonce la clôture`).
2. **Même vote vu deux fois** (dans la photo et en événement, ou redelivery JetStream) : le roster ne doit ni dupliquer le joueur ni bouger son rang. Test dans la tâche 3 (`événement déjà reflété par votedAt ignoré`).
3. **resa-squash en panne pendant le tick** : le roster reste identique et n'est pas republié. Test dans la tâche 10 (`lookup en échec : nom WhatsApp mémorisé, pas de republication au tick suivant`).
4. **Pod tué entre l'envoi du nouveau roster et la mémorisation du `msgId`** : au redémarrage, pas de troisième message en boucle ; le pire cas est un roster en double, signalé sur Telegram à la reprise du claim périmé. Tests dans la tâche 6 (`claim en cours : aucun envoi concurrent`, `claim périmé repris → Telegram « possible doublon »`).
5. **Une heure qui n'existait pas au plan reçoit un vote** : elle doit apparaître en attente avec « pas de court réservé », sans crash. Test dans la tâche 4 (`vote pour une heure sans plafond`).

---

### Task 1 : Requête de vérification des données réelles (spec §4.2, R2-4, C1-4)

**Files :**
- Create : `docs/plan/verif-roster-votes.sql`

Cette requête est **en lecture seule**. Vinz l'exécute lui-même sur la base de prod : l'agent n'y a pas accès. Elle ne renvoie que des comptages, aucun téléphone.

- [ ] **Step 1 : écrire la requête.** Cinq `select` :
  1. pour les 6 derniers `job_runs` avec `poll_msg_id`, le nombre d'événements `poll_vote_%` dont `payload->'data'->>'pollWhatsappMessageId' = poll_msg_id` ;
  2. sur les `poll_vote_%`, les comptes : total, `actor_phone is null`, `actor_jid like '%@lid'`, `@lid` sans téléphone ;
  3. par `event_type`, le nombre d'événements avec `selectedOptions` et `previousOptions` vides tous les deux ;
  4. pour les votes `@lid` sans téléphone, si `actor_name` est présent (compte) ;
  5. pour les votes `@lid` sans téléphone, combien ont un `actor_name` égal au `name` d'un votant non identifié du détail `collect_votes` du même job (`detail->'unresolvedVoters'`). C'est la seule comparaison des noms possible avant le déploiement, puisque la photo n'existe pas encore (P2-16). Comptages seulement.

  En tête de fichier, un commentaire donne la commande `kubectl -n squash-assistant exec -i <pod postgres> -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A' < docs/plan/verif-roster-votes.sql`. Les variables sont développées dans le pod, pas en local (P1-18).
- [ ] **Step 2 : commit.** `docs(plan): requête de vérification des événements de vote (roster)`.

Le résultat est demandé à Vinz **dès la fin de cette tâche** (P1-19). Les tâches 2 à 7 peuvent avancer en attendant. La **tâche 8 attend le résultat**. S'il montre `matched = 0` pour des sondages qui ont reçu des votes, c'est un arrêt et une question à Vinz : le filtre de la tâche 2 serait à revoir.

---

### Task 2 : Migration et accès en base

**Files :**
- Modify : `packages/db/src/schema.ts` (table `jobRuns`)
- Create : `packages/db/src/migrations/0034_roster_vivant.sql` et le snapshot, via `npm run db:generate -w @squash-assistant/db -- --name roster_vivant`
- Create : `apps/worker/src/roster/rosterStore.ts`
- Test : `apps/worker/src/roster/rosterStore.test.ts`

**Interfaces :**
- Produces (schéma) : colonnes de `job_runs`. Toutes sont nullables, sans défaut.

  | Colonne | Type | Champ Drizzle |
  |---|---|---|
  | `roster_photo` | jsonb | `rosterPhoto` |
  | `roster_identities` | jsonb | `rosterIdentities` |
  | `roster_plan_snapshot` | jsonb | `rosterPlanSnapshot` |
  | `roster_final` | jsonb | `rosterFinal` |
  | `roster_msg_id` | text | `rosterMsgId` |
  | `roster_jid` | text | `rosterJid` |
  | `roster_sent_at` | timestamp | `rosterSentAt` |
  | `roster_fingerprint` | text | `rosterFingerprint` |
  | `roster_pinned_at` | timestamp | `rosterPinnedAt` (roster courant épinglé si non nul ; sert à l'expiration de l'orphelin, P1-8) |
  | `roster_orphan` | jsonb | `rosterOrphan` |
  | `roster_claimed_at` | timestamp | `rosterClaimedAt` |
  | `roster_stopped_at` | timestamp | `rosterStoppedAt` |
  | `poll_unpinned_at` | timestamp | `pollUnpinnedAt` |

  Les types jsonb sont déclarés avec `$type<…>()`. Ils viennent de `packages/db/src/rosterTypes.ts`, un fichier de types seulement, **créé dans cette tâche**. Il contient le bloc de types donné en tâche 3 **et** `VoteEventRow` (P1-7). Ajouter l'entrée `"./rosterTypes"` aux `exports` de `packages/db/package.json`, sur le modèle de `"./playerLabel"`. La tâche 3 ne fait que l'utiliser.
- Produces (`rosterStore.ts`) :
  - `listPollVoteEvents(db, { chatJid: string; pollMsgId: string }): Promise<VoteEventRow[]>`
    - lit `whatsapp_resa_events` avec `event_type in (poll_vote_creation, poll_vote_update, poll_vote_deletion)`, `chat_jid` et `payload->'data'->>'pollWhatsappMessageId'` ;
    - trie par `created_at`, puis `event_id` ;
    - mappe vers `VoteEventRow` (tâche 3).
  - `listPollVoteEventIds(db, sameArgs): Promise<string[]>`
  - `saveRosterPhoto(db, jobId, photo: VotePhoto, identities: Identities): Promise<void>`
  - `mergeRosterIdentities(db, jobId, patch: Identities, mode: "override" | "keep"): Promise<void>` : fusion **atomique** en une requête (P2-10). Deux modes (PC1-8) :
    - `mode: "override"` (identifications de « Recalculer », R1-4) : `SET roster_identities = coalesce(roster_identities,'{}') || $patch`, le patch l'emporte ;
    - `mode: "keep"` (recherche d'un votant nouveau par BookSlots ou le tick) : `SET roster_identities = $patch || coalesce(roster_identities,'{}')`, ce qui est déjà en base l'emporte. Une recherche ratée n'écrase donc jamais une identification.
  - `saveRosterPlanSnapshot(db, jobId, snapshot: RosterPlanSnapshot): Promise<void>`
  - `saveRosterFinal(db, jobId, final: RosterFinal): Promise<void>`
  - `claimRosterPublish(db, jobId, now: Date, staleMs = 120_000): Promise<{ job: JobRun; reclaimedStale: boolean } | null>` : renvoie la **ligne fraîche** (P1-1). Implémentation en une requête, par une CTE qui lit l'ancienne valeur (P2-3) :

  ```sql
  WITH prev AS (SELECT roster_claimed_at FROM job_runs WHERE id = $1)
  UPDATE job_runs SET roster_claimed_at = $now
  WHERE id = $1 AND (roster_claimed_at IS NULL OR roster_claimed_at < $now - $stale)
  RETURNING job_runs.*, (SELECT roster_claimed_at FROM prev) AS prev_claimed_at
  ```

  Le mieux est de passer par le query builder Drizzle (`db.update(jobRuns).set(…).where(…).returning({ ...getTableColumns(jobRuns), prevClaimedAt: sql\`(select roster_claimed_at from prev)\` })`, avec la CTE `prev` en `$with`), qui mappe vers `JobRun`. À défaut, `db.execute`, avec un mappage testé (PC1-3). `reclaimedStale = prev_claimed_at != null`. Même idée que `claimStartReminder` (`apps/worker/src/jobRuns.ts`).
  - `releaseRosterPublish(db, jobId, claimedAt: Date)` : remet `roster_claimed_at` à null **seulement si** sa valeur vaut encore `claimedAt`. Un claim repris par un autre n'est pas libéré.
  - `setRosterMessage(db, jobId, msg: { msgId: string; jid: string; sentAt: Date; fingerprint: string } | null): Promise<void>` : remet toujours `roster_pinned_at` à null. `null` remet aussi `msgId`, `jid`, `sentAt` et `fingerprint` à null.
  - `setRosterFingerprint(db, jobId, fingerprint: string)` : cas d'un envoi sans `msgId` (P1-11).
  - `setRosterPinnedAt(db, jobId, at: Date | null)`
  - `setRosterOrphan(db, jobId, orphan: RosterOrphan | null)`
  - `setRosterStoppedAt(db, jobId, at: Date)`
  - `setPollUnpinnedAt(db, jobId, at: Date)`
  - `listJobsWithRoster(db, fromDate: string): Promise<JobRun[]>` : `roster_photo is not null and roster_stopped_at is null and cancelled_at is null and target_date >= fromDate`.
  - `listJobsWithRosterOrphan(db): Promise<JobRun[]>` : `roster_orphan is not null`, sans autre filtre (C3-3).
  - `listJobsWithPinnedPoll(db): Promise<JobRun[]>` : `roster_photo is not null and poll_msg_id is not null and poll_unpinned_at is null`, sans filtre de date ni d'état (P1-3).

- [ ] **Step 1 : test qui échoue.** Dans `rosterStore.test.ts`, sur le modèle des tests existants qui touchent Drizzle (`apps/worker/src/jobRuns.test.ts` s'il existe, sinon un faux `db` avec `vi.fn()` chaînés comme dans `apps/worker/src/http/clubClosuresHandlers.test.ts`) :
  - `listPollVoteEvents mappe payload.data vers VoteEventRow` : `selectedOptions`, `previousOptions`, `actorPhone`, `actorJid`, `actorName`, `occurredAt` et `createdAt` en `Date` ;
  - `setRosterMessage(null) remet msgId, jid, fingerprint et roster_pinned_at à null`.
  - `listPollVoteEvents ne retient que les poll_vote_* du sondage et du groupe (CA-11)` : vérifie les conditions passées au faux `db` (P1-10).
  - `claimRosterPublish renvoie la ligne fraîche, et null si un claim récent existe ; reclaimedStale vrai si un claim périmé est repris`.
  - `releaseRosterPublish ne libère que son propre claim`.
  - `mergeRosterIdentities : en "keep" la valeur en base l'emporte, en "override" le patch l'emporte` : ordre des opérandes de `||` (PC2-6).
- [ ] **Step 2 : lancer** `npm run worker:test -- rosterStore`. Attendu : FAIL (module absent).
- [ ] **Step 3 : implémenter** le schéma, générer la migration (vérifier que le SQL ne contient que des `ADD COLUMN`), puis `rosterStore.ts`.
- [ ] **Step 4 : lancer** `npm run db:build && npm run worker:test -- rosterStore && npm run typecheck`. Attendu : PASS.
- [ ] **Step 5 : commit.** `feat(db): colonnes du roster vivant sur job_runs`.

---

### Task 3 : `voteLedger.ts`, la photo et les événements de vote (CA-2, CA-11, §4.2)

**Files :**
- Use : `packages/db/src/rosterTypes.ts` (créé en tâche 2, contenu ci-dessous)
- Create : `apps/worker/src/roster/voteLedger.ts`
- Test : `apps/worker/src/roster/voteLedger.test.ts`

**Interfaces :**
- Produces (types, `rosterTypes.ts`) :

```ts
export type VoterKey = string; // "tel:+33…" | "jid:…" | "nom:…"
export interface PhotoVoter { key: VoterKey; phone: string | null; waName: string; option: string; votedAt: number | null }
export interface VotePhoto { capturedAt: string; integratedEventIds: string[]; voters: PhotoVoter[] }
export interface VoterIdentity { userId: string | null; name: string }
export type Identities = Record<VoterKey, VoterIdentity>;
export interface VoterVote { option: string | null; lastAt: number | null } // option null = ne joue pas
export type VoteState = Record<VoterKey, VoterVote>;
export interface RosterPlanSnapshot { tPlan: string; state: VoteState; integratedEventIds: string[] }
export interface HourCapacity { time: string; capacity: number }
export interface RosterFinal {
  base: RosterPlanSnapshot; hours: HourCapacity[]; realBooking: boolean;
  title: string; courtsBlock: string; failuresNote: string; capacityNote: string;
}
export interface RosterOrphan { msgId: string; jid: string; expiresAt: string }
```

- `rosterTypes.ts` contient aussi (P1-7) : `interface VoteEventRow { eventId: string; eventType: string; createdAt: Date; occurredAt: Date; actorPhone: string | null; actorJid: string; actorName: string | null; selectedOptions: string[]; previousOptions: string[] }`.
- Produces (`voteLedger.ts`) :
  - `normalizePhone(raw: string | null | undefined): string | null` : garde les chiffres, préfixe `+`, et renvoie null s'il ne reste rien.
  - `photoVoterKey(phone: string | null, waName: string): VoterKey`
  - `photoState(photo: VotePhoto): VoteState` : « Non » et toute option hors heures et hors prête-nom donnent `option: null`. Pour normaliser les options, la fonction reçoit `candidateStartTimes` via `optionOf` (ci-dessous). Signature réelle : `photoState(photo, candidateStartTimes: string[])`.
  - `eventVoterKey(event: VoteEventRow, photo: VotePhoto): { key: VoterKey; matchedBy: "phone" | "name" | "jid" }`. Règle :
    1. téléphone normalisé → `tel:` ;
    2. sinon `actorName` égal (trim) au `waName` d'un votant de la photo → la clé de ce votant ;
    3. sinon `jid:<actorJid>`.
  - `applyVoteEvents(photo: VotePhoto, events: VoteEventRow[], candidateStartTimes: string[], from: { state: VoteState; integratedEventIds: string[] }): ApplyResult`, avec :

```ts
interface ApplyResult {
  state: VoteState;
  applied: Array<{ eventId: string; key: VoterKey; option: string | null }>; // dans l'ordre reçu
  integratedEventIds: string[]; // from.integratedEventIds ∪ ids de tous les events reçus
  suspiciousDeletions: VoteEventRow[]; // selected [] et previous [] → ignoré (R2-16)
  unmatchedNoPhone: VoteEventRow[]; // matchedBy "jid" (C1-4)
}
```

    `events` arrive déjà trié (tâche 2). Un événement de `from.integratedEventIds` est sauté. Un événement périmé (`occurredAt.getTime() <= state[key].lastAt`) est sauté mais compté comme intégré.
  - `toResolvedVotes(state: VoteState, identities: Identities, candidateStartTimes: string[]): ResolvedVotes` (type existant de `apps/worker/src/graph/resolveVotes.ts`). Un votant avec `userId` va dans `confirmedPlayerIdsByTime` ou `volunteerSubstituteIds` et dans `voterNames`. Sans `userId`, il va dans `unresolvedVoters` avec `{ name, phone, option }`, où `phone` vient de la clé `tel:` ou vaut null.

- [ ] **Step 1 : tests qui échouent.** Fixture : candidats `["9H00","10H30"]`. `formatSessionTime` garde le zéro de tête (`"09H00"` → `"09h"`), d'où `9H00`, pour que les rendus de la tâche 5 donnent `9h` (P1-6). Les mêmes candidats servent aux tâches 4, 5, 10 et 13. Ci-dessous, « 09H00 » se lit `9H00`. Photo : Henry `tel:+331`, `09H00`, `votedAt` 1000 ; Stef `tel:+332`, `09H00`, `votedAt` 2000.
  - `retrait : selectedOptions [] → option null` : l'événement Henry `previous ["09H00"]`, `selected []`, `occurredAt` 3000 donne `state["tel:+331"].option === null`.
  - `événement déjà reflété par votedAt ignoré` : Henry `selected ["10H30"]`, `occurredAt` 1000 → l'option reste `"09H00"`, et `integratedEventIds` contient l'id.
  - `événement déjà intégré sauté` : un id présent dans `from.integratedEventIds` n'est pas appliqué.
  - `faux retrait ignoré et signalé` : `selected []` et `previous []` → dans `suspiciousDeletions`, l'état est inchangé.
  - `@lid sans téléphone rapproché par nom` : `actorPhone null`, `actorName "Stef"` (le `waName` de la photo) → `key === "tel:+332"`.
  - `@lid sans téléphone ni nom correspondant compté sous son JID` : `key === "jid:x@lid"`, présent dans `unmatchedNoPhone`.
  - `option « Non » ne joue pas` : `selected ["Non"]` → option null.
  - `seuls les poll_vote_* comptent (CA-11)` : non testable ici (le filtre est côté SQL, tâche 2). Le test vérifie seulement qu'un `eventType` hors `poll_vote_*` passé par erreur est ignoré.
  - `toResolvedVotes` : Henry identifié `u1` à `09H00` → `confirmedPlayerIdsByTime["09H00"]` contient `u1`. Un inconnu `tel:+339` à `10H30` → `unresolvedVoters[0]` vaut `{ name: <nom mémorisé>, phone: "+339", option: "10H30" }`.
- [ ] **Step 2 : lancer** `npm run worker:test -- voteLedger`. Attendu : FAIL.
- [ ] **Step 3 : implémenter** `voteLedger.ts`. Fonctions pures, sans mutation des entrées (copies).
- [ ] **Step 4 : lancer** les tests et `npm run typecheck`. Attendu : PASS.
- [ ] **Step 5 : commit.** `feat(roster): état des votes depuis la photo et les événements`.

---

### Task 4 : `allocation.ts`, places, attente et remplacements (CA-4 à CA-8)

**Files :**
- Create : `apps/worker/src/roster/allocation.ts`
- Test : `apps/worker/src/roster/allocation.test.ts`

**Interfaces :**
- Consumes : `VoteState`, `HourCapacity`, `VoterKey` (tâche 3).
- Produces :

```ts
export interface SeatSlot { key: VoterKey | null; replaces: VoterKey | null; freedBy: VoterKey | null; freedSeq: number | null }
export interface HourRoster { time: string; capacity: number; slots: SeatSlot[]; waiting: VoterKey[] }
export function initialRosters(hours: HourCapacity[], state: VoteState, displayName: (key: VoterKey) => string): HourRoster[];
export function applyMoves(rosters: HourRoster[], moves: Array<{ key: VoterKey; option: string | null }>, candidateStartTimes: string[]): HourRoster[];
export function seatedKeys(roster: HourRoster): VoterKey[];
```

- `initialRosters(hours, state, displayName: (key) => string)` : pour chaque heure, les votants à cette heure sont triés par `lastAt` croissant (null en dernier). Une égalité est départagée par le téléphone de la clé `tel:` (sans téléphone en dernier), puis par `displayName` (spec §4.5, P1-17). Les `capacity` premiers occupent les slots, les autres attendent. Avec un plafond 0, il n'y a aucun slot et tous attendent.
- `applyMoves` applique la spec §4.6, règles 1 à 3 :
  - **retrait d'un inscrit** : le premier en attente prend le slot avec `replaces = sortant`. Si l'attente est vide, le slot devient `{ key: null, freedBy: sortant, freedSeq: n++ }` ;
  - **entrée** : le votant reprend d'abord le slot libre dont `freedBy` est lui-même (`replaces: null`). Sinon, il prend le slot libre au plus petit `freedSeq`, avec `replaces = freedBy`. S'il n'y a aucun slot libre, il va en fin d'attente ;
  - une heure candidate absente de `rosters` est créée avec `capacity 0` ;
  - une option hors candidats (y compris prête-nom) vaut un retrait ;
  - le compteur `freedSeq` est dérivé du maximum existant, pour que `applyMoves` reste pure et rejouable.

- [ ] **Step 1 : tests qui échouent.** Chaque test cite son CA dans son nom.
  - `CA-4 : 5e oui à 09H00 sans désistement → attente, 4 inscrits`
  - `CA-5 : Henry se retire, Hugo2 premier en attente → slot Hugo2 replaces Henry`
  - `CA-6 : place libre, deux votants successifs → le 1er inscrit (replaces Henry), le 2e en attente`
  - `CA-7 : place libre à 09H00, vote 10H30 complet → attente 10H30, slot 09H00 toujours libre`
  - `CA-8 : désisté dont la place est reprise revote → fin d'attente`
  - `R2-5 : il reprend sa propre place libérée, sans mention`
  - `R2-5 : deux places libérées (Henry puis Stef) → un nouveau prend celle d'Henry`
  - `changement d'heure d'un inscrit : libère 09H00, attend à 10H30 si complet`
  - `vote pour une heure sans plafond : heure créée capacity 0, votant en attente` (Review Focus 5)
  - `pureté : rejouer applyMoves sur les mêmes entrées donne un résultat identique et n'altère pas l'entrée`
- [ ] **Step 2 : lancer** `npm run worker:test -- allocation`. Attendu : FAIL.
- [ ] **Step 3 : implémenter.**
- [ ] **Step 4 : lancer** les tests et le typecheck. Attendu : PASS.
- [ ] **Step 5 : commit.** `feat(roster): attribution des places, attente et remplacements`.

---

### Task 5 : `rosterMessage.ts`, rendu et empreinte (CA-1, CA-3, §4.4, §4.5)

**Files :**
- Create : `apps/worker/src/roster/rosterMessage.ts`
- Test : `apps/worker/src/roster/rosterMessage.test.ts`

**Interfaces :**
- Consumes : `HourRoster`, `seatedKeys` (tâche 4) ; `Identities`, `VoteState`, `RosterFinal` (tâche 3) ; `publicVoterName` (registrationRecap.ts) ; `formatInformalDate`, `formatSessionTime` et `SUBSTITUTE_VOLUNTEER_POLL_OPTION` (pollQuestion.ts).
- Produces :
  - `rosterDisplayName(key: VoterKey, identities: Identities): string` : `identities[key].name`, passé par `publicVoterName` quand `userId` est null. Sans identité : « un joueur ».
  - `buildProvisionalRosterMessage(input: { targetDate: string; candidateStartTimes: string[]; state: VoteState; identities: Identities }): string`
  - `buildFinalRosterMessage(input: { final: RosterFinal; targetDate: string; rosters: HourRoster[]; identities: Identities; candidateStartTimes: string[] }): string`
  - `rosterFingerprint(text: string): string` : sha256 hex (`node:crypto`).
  - `rosterInscritsByTime(rosters: HourRoster[], identities: Identities): Record<string, string[]>`

**Format exact, provisoire (§4.4)** :
- titre `📋 Inscrits — ${formatInformalDate(date)} 🎾` ;
- une ligne `⏰ ${formatSessionTime(h)} (${n}) : noms` par heure ayant au moins un inscrit, dans l'ordre de `candidateStartTimes`, les noms par `lastAt` croissant ;
- la ligne 🙏 des prête-noms, identique au récap actuel ;
- puis `Les courts arrivent bientôt 😉` et `Pour te désister, retire ton vote dans le sondage 🙏` ;
- sans inscrit : `📋 Inscrits — <date>\nPersonne pour l'instant 😢`.

**Format exact, définitif (§4.5)** :
- `final.title`, ligne vide, `📅 ${targetDate}`, ligne vide, `final.courtsBlock`, ligne vide ;
- puis, par heure (ordre de `candidateStartTimes`) :
  - plafond > 0 : `⏰ ${h} (${n}/${cap}) : noms`, où chaque nom est suivi de ` (remplace X)` si `replaces` est renseigné, et suffixé de ` — ${k} place libre` (ou `places libres` si k ≥ 2) quand k > 0 ;
  - plafond > 0 sans inscrit : `⏰ ${h} (0/${cap}) — ${k} place libre` (ou `places libres` si k ≥ 2, P1-16) ;
  - plafond 0 avec attente : `⏰ ${h} : pas de court réservé` ;
  - plafond 0 sans attente : rien ;
  - attente non vide : `⏳ En attente ${h} : noms` ;
- puis `final.failuresNote` et `final.capacityNote`, tels quels ;
- puis une ligne vide, `Changer d'heure = repasser en attente si l'heure est pleine.` et `Pour te désister, retire ton vote dans le sondage 🙏`.

`h` est rendu avec `formatSessionTime`.

- [ ] **Step 1 : tests qui échouent.**
  - `CA-1 rendu provisoire` : les lignes exactes pour 09H00 (4) et 10H30 (2), et les deux lignes de pied.
  - `provisoire sans inscrit`
  - `CA-3 rendu définitif` : on rejoue l'exemple §4.5. Plafonds 09H00 = 4 et 10H30 = 2 ; Paul se retire ; Hugo2 et Terence votent 09H00 ; Henry se retire. Attendu, en sous-chaînes :
    - `⏰ 9h (4/4) : Hugo2 (remplace Henry), Stef, Vinz, Laurent`
    - `⏳ En attente 9h : Terence`
    - `⏰ 10h30 (1/2) : Max — 1 place libre`
  - `heure plafond 0 avec attente → « pas de court réservé »`, et `heure plafond 0 sans attente → absente`
  - `jamais de téléphone ni de JID` : une identité `{ userId: null, name: "+33 6 12 34 56 78" }` est rendue « un joueur » ; une clé `jid:x@lid` sans identité aussi. Une identité `{ userId: null, name: "Léa" }` sur une clé `jid:` est rendue « Léa » (PC2-2).
  - `empreinte stable` : même texte, même empreinte ; un caractère de plus, empreinte différente.
- [ ] **Step 2 : lancer.** Attendu : FAIL.
- [ ] **Step 3 : implémenter.** Les helpers d'affichage déjà existants (`formatSessionTime`, `publicVoterName`, la jonction française de la ligne 🙏) sont réutilisés : `joinFrench` est exporté depuis `registrationRecap.ts` s'il le faut, sans le dupliquer.
- [ ] **Step 4 : lancer.** Attendu : PASS.
- [ ] **Step 5 : commit.** `feat(roster): messages du roster provisoire et définitif`.

---

### Task 6 : `publishRoster.ts`, publication, retrait et orphelin (CA-9, R2-3, C2-1, C3-1, C3-2)

**Files :**
- Create : `apps/worker/src/roster/publishRoster.ts`
- Modify : `apps/worker/src/graph/pinning.ts` (exporter `PIN_DURATION`, ajouter `PIN_DURATION_MS`)
- Test : `apps/worker/src/roster/publishRoster.test.ts`

**Interfaces :**
- Consumes : `rosterStore` (tâche 2), `rosterFingerprint` (tâche 5), `sendMessage`, `deleteMessage`, `pinMessage` et `unpinMessage` (`apps/worker/src/mcp/huddleBot.ts`), `POLL_DELETE_MAX_AGE_HOURS`, `PIN_DURATION` (à exporter de `pinning.ts`), `sendTelegramMessage`.
- Produces :

```ts
export interface RosterPublishContext {
  deps: Pick<GraphDependencies, "db" | "huddleBot" | "telegram">;
  job: JobRun; ruleLabel: string; pinEnabled: boolean; notifyJid: string; now: Date;
}
export type PublishOutcome = "published" | "unchanged" | "busy" | "failed";
export type RosterPhase = "provisional" | "final";
export async function publishRoster(ctx: RosterPublishContext, text: string, phase: RosterPhase): Promise<PublishOutcome>;
export async function withdrawRoster(ctx: RosterPublishContext, opts?: { unpinOnly?: boolean }): Promise<boolean>;
export async function retryOrphanUnpin(ctx: RosterPublishContext): Promise<void>;
export function __resetRosterTelegramLogForTests(): void;
```

**`publishRoster`, dans l'ordre :**
1. Si `rosterFingerprint(text) === ctx.job.rosterFingerprint` : renvoyer `"unchanged"` (raccourci sans écriture).
2. `claim = claimRosterPublish(...)`. Si null : renvoyer `"busy"`. Pour la collecte et l'annonce, `"busy"` n'est pas une erreur : le tick rattrape. Si `claim.reclaimedStale`, un Telegram signale un possible roster en double (P1-12).
3. Dans un `try`, avec un `finally` qui appelle `releaseRosterPublish(db, jobId, now)`, `now` étant la valeur écrite par le claim. `withdrawRoster` et `retryOrphanUnpin` font de même pour leur propre claim (PC1-3). Le seuil `now - staleMs` est calculé en JavaScript et passé en paramètre. **Tout ce qui suit lit `fresh = claim.job`, jamais `ctx.job`** (P1-1) :
   1. si `rosterFingerprint(text) === fresh.rosterFingerprint`, renvoyer `"unchanged"`. Si `phase === "provisional"` et `fresh.rosterFinal` existe déjà, renvoyer aussi `"unchanged"` : le définitif ne se fait jamais remplacer par un provisoire ;
   2. `sendMessage(notifyJid, text)`. En cas d'échec : Telegram dédupliqué, `"failed"`, et l'empreinte n'est pas modifiée. Si le `msgId` est absent (P1-11) : `setRosterFingerprint`, Telegram dédupliqué, pas de retrait de l'ancien, `"published"` ;
   3. `setRosterMessage({ msgId, jid, sentAt: now, fingerprint })` ;
   4. retirer l'ancien (`fresh.rosterMsgId` / `rosterJid` s'ils existent) :
      - s'il a moins de 48 h (`fresh.rosterSentAt`), `deleteMessage`. En cas d'échec : Telegram dédupliqué (P1-13) ;
      - si la suppression échoue, ou s'il a 48 h ou plus : `unpinMessage` seulement si `fresh.rosterPinnedAt` ;
      - si ce désépinglage échoue : `setRosterOrphan({ msgId, jid, expiresAt: fresh.rosterPinnedAt + PIN_DURATION_MS })` et un Telegram (P1-8) ;
   5. épingler le nouveau seulement si `pinEnabled`, si `fresh.rosterOrphan` est nul et si aucun orphelin n'a été créé à l'étape 4. Un ancien roster **non épinglé** dont la suppression a échoué ne bloque pas l'épinglage (P2-14). Puis `setRosterPinnedAt(now)`. Un échec d'épinglage donne un Telegram ;
   6. renvoyer `"published"`.

**`withdrawRoster`** : sous claim et sur la ligne fraîche, même retrait que l'étape 3.4 sur le roster courant, puis `setRosterMessage(null)` (C1-2, R2-11). Avec `unpinOnly` (cas du sondage suivant, tâche 7), on ne supprime jamais et on **n'oublie pas** le roster (P2-2) : on désépingle seulement si `rosterPinnedAt`, puis `setRosterPinnedAt(null)`, et `msgId` comme l'empreinte sont conservés. Sinon, un roster encore vivant serait republié en double. Si le désépinglage échoue, l'orphelin est mémorisé, comme à l'étape 3.4. Limite acceptée (PC1-10, défaut A) : si le roster du job précédent est republié ensuite (vote avant son premier créneau), il est réépinglé par les règles normales. Il en va de même via la passe des orphelins du tick, si un autre orphelin de ce job se libère (PC2-7). La règle du §4.7 reste respectée : au plus 1 roster épinglé par job. Ajouter les tests `withdrawRoster unpinOnly → unpin sans delete, msgId et empreinte conservés`.

`withdrawRoster` en `"busy"` (claim pris) : on ne fait rien et on renvoie `false`. Signature : `Promise<boolean>`, vrai si le retrait est fait. L'appelant qui ne repasse jamais (fermeture PUC, tâche 12) retente jusqu'à 3 fois, à 1 s d'intervalle, puis envoie un Telegram (P2-5).

**`retryOrphanUnpin`** :
- si `expiresAt <= now` : `setRosterOrphan(null)` ;
- sinon `unpinMessage(orphan.jid, orphan.msgId)`. En cas de succès, `setRosterOrphan(null)`. Ensuite (C3-2), **sous claim et sur la ligne fraîche** (P2-6) : si `pinEnabled`, si un roster courant existe (`rosterMsgId`) **différent de l'orphelin** (`orphan.msgId !== fresh.rosterMsgId`, PC2-7), si `!rosterPinnedAt` et si `rosterStoppedAt` est nul, épingler `fresh.rosterMsgId` sur **`fresh.rosterJid`**, puis `setRosterPinnedAt(now)`. Un claim occupé laisse l'épinglage au tick suivant.

**Telegram** : dédupliqué en mémoire, par `job.id + motif`, comme `recapUnpinLoggedJobIds` dans `scheduler.ts`.

- [ ] **Step 1 : tests qui échouent.** On mocke `huddleBot.js`, `rosterStore.js` et `telegram.js`, comme le fait `collectVotes.test.ts`.
  - `empreinte inchangée → aucun envoi`
  - `CA-9 : ancien roster < 48 h → deleteMessage, nouveau épinglé`
  - `CA-9 : ancien roster ≥ 48 h, épinglé → unpin seul, pas de delete`
  - `CA-9 : ancien ≥ 48 h, pin désactivé → ni delete ni unpin`
  - `ordre : sendMessage avant tout retrait, épinglage du nouveau après le retrait` (ordre des appels des mocks)
  - `R2-3/C2-1 : delete et unpin échouent → orphelin mémorisé (expiresAt = rosterPinnedAt + 7 j), nouveau non épinglé, Telegram`
  - `P1-1 : claim obtenu après une publication concurrente → empreinte et ancien message relus sur la ligne fraîche, aucun envoi`
  - `P1-1 : provisoire refusé si la ligne fraîche a déjà un rosterFinal`
  - `P2-14 : ancien roster non épinglé dont la suppression échoue → nouveau épinglé` (PC1-9)
  - `envoi sans msgId → empreinte mémorisée, ancien non retiré, Telegram`
  - `claim périmé repris → Telegram « possible doublon »`
  - `C2-1 : orphelin présent → aucun épinglage même si le retrait réussit`
  - `C3-2 : retryOrphanUnpin réussit → orphelin oublié et roster courant épinglé`
  - `retryOrphanUnpin après expiration → oublié sans appel huddle-bot`
  - `retryOrphanUnpin : orphelin = roster courant → désépinglé, jamais réépinglé` (PC2-7)
  - `claim en cours : aucun envoi concurrent` (Review Focus 4) : `claimRosterPublish` renvoie null, donc `"busy"` et zéro `sendMessage`.
  - `échec d'envoi → "failed", empreinte non mise à jour, release appelé`
  - `withdrawRoster < 48 h → delete puis setRosterMessage(null)`
- [ ] **Step 2 : lancer.** Attendu : FAIL.
- [ ] **Step 3 : implémenter.** Exporter `PIN_DURATION` de `pinning.ts`. La durée de 7 j est dérivée par `PIN_DURATION_MS = 7 * 24 * 3600 * 1000`, défini dans `pinning.ts` à côté de `PIN_DURATION`.
- [ ] **Step 4 : lancer.** Attendu : PASS.
- [ ] **Step 5 : commit.** `feat(roster): publication du roster vivant, retrait de l'ancien et orphelin`.

---

### Task 7 : le sondage ne mentionne plus de clôture ; nettoyage au sondage suivant (§4.1, ADR-034 point 4)

**Files :**
- Modify : `apps/worker/src/graph/nodes/sendPoll.ts` (passer `null` comme `closureDeadline` ; ajouter le nettoyage)
- Modify : `apps/worker/src/jobRuns.ts` (`findPreviousJobWithRoster`, avec un test dans `sendPoll.test.ts` par mock, sur le modèle de `findPreviousPinnedRecap`) (P2-15)
- Modify : `apps/ui/src/lib/pipelinePreview.ts` (`buildPollQuestionPreview` sans mention de clôture)
- Test : `apps/worker/src/graph/nodes/sendPoll.test.ts`, `apps/ui/src/lib/pipelinePreview.test.ts`

**Interfaces :**
- Consumes : `withdrawRoster`, `retryOrphanUnpin` (tâche 6) ; `setPollUnpinnedAt`, `listJobsWithRosterOrphan` (tâche 2) ; `jobRuns.findPreviousJobWithRoster(db, bookingRuleId, excludeJobId): Promise<JobRun | undefined>`. Cette dernière est **à ajouter dans `jobRuns.ts`**, sur le modèle de `findPreviousPinnedRecap` : dernier job de la règle, hors job courant, avec `roster_msg_id` non nul, ou avec un `poll_msg_id` dont `poll_unpinned_at` est nul et `roster_photo` non nul.

Au début du nœud, après `unpinPreviousRecap`, `cleanupPreviousRoster` agit, indépendamment de la case :
1. désépinglage best-effort du sondage précédent (`poll_msg_id` sur `ruleSnapshot.whatsappGroupJid`). `setPollUnpinnedAt` n'est écrit **qu'en cas de réussite** (P2-7) ; sinon la passe sondage de la tâche 11 réessaie ;
2. `withdrawRoster(ctx, { unpinOnly: true })` (tâche 6) : le roster précédent n'est pas supprimé au sondage suivant, il est seulement désépinglé. Son `msgId` et son empreinte sont **conservés** (P2-2, PC1-1), pour qu'il n'y ait pas de republication en double au tick. S'il renvoie `false` (claim pris), un simple Telegram ; le sondage n'est pas retardé (PC2-5) ;
3. `retryOrphanUnpin` avec `pinEnabled: false`, qui ne réépingle rien (PC2-7).

- [ ] **Step 1 : tests qui échouent.**
  - `question envoyée sans « réponses jusqu'au »` : `askPoll` reçoit une question qui ne contient pas `POLL_CLOSURE_MARKER`.
  - `aperçu UI sans mention de clôture`
  - `nettoyage du job précédent : sondage désépinglé et poll_unpinned_at écrit, roster désépinglé avec msgId et empreinte conservés (pas de republication au tick suivant), orphelin retenté`
- [ ] **Step 2 : lancer** `npm run worker:test -- sendPoll` et `npm test -w @squash-assistant/ui -- pipelinePreview`. Attendu : FAIL.
- [ ] **Step 3 : implémenter.** Ajuster les tests existants qui attendaient la mention de clôture **dans l'envoi**. C'est un changement de règle voulu par la spec (§4.1), pas un test qu'on fait passer au vert par commodité. Le dire dans le message de commit.
- [ ] **Step 4 : lancer**, avec le typecheck. Attendu : PASS.
- [ ] **Step 5 : commit.** `feat(sondage): plus de mention de clôture, nettoyage du roster du job précédent`.

---

### Task 8 : CollectVotes, photo, sondage conservé et roster provisoire (CA-1, §4.1, §4.2, R2-1)

**Files :**
- Modify : `apps/worker/src/mcp/huddleBot.ts` (`PollResponses.responses[]` reçoit `votedAt?: number | null`)
- Modify : `apps/worker/src/graph/resolveVotes.ts` (renvoie aussi `photoVoters: PhotoVoter[]` et `identities: Identities`)
- Modify : `apps/worker/src/graph/nodes/collectVotes.ts`
- Test : `apps/worker/src/graph/nodes/collectVotes.test.ts`, `apps/worker/src/graph/resolveVotes.test.ts`

**Interfaces :**
- Consumes : `listPollVoteEventIds`, `saveRosterPhoto` (tâche 2) ; `photoState` (tâche 3) ; `buildProvisionalRosterMessage`, `publishRoster` (tâches 5 et 6) ; `pollAnnouncedClosure`, `readSentPoll` (existant).
- Produces : `VoteReading` gagne `photoVoters` et `identities`. Pour chaque répondant à une heure ou prête-nom, `PhotoVoter` vaut `{ key: photoVoterKey(phone, member), phone, waName: member, option: statut, votedAt }`. Les répondants « Non » sont aussi dans la photo, avec leur statut : leur `votedAt` sert à la règle de l'événement périmé. `identities[key]` vaut `{ userId, name: playerMessageName || member }`, **seulement pour les votants dont l'identité a été cherchée** : heure ou prête-nom (P2-1). Un « Non » n'est pas cherché par `resolveVotes`, et n'est donc pas mis dans `identities`. S'il revote « oui », il est traité comme un votant nouveau, avec un lookup (tâche 9).

**Choix du chemin dans `createCollectVotesNode`** :
- **legacy** si `job.pollClosedAt`, ou si `pollAnnouncedClosure(question du sondage envoyé)` **et** que le groupe de l'annonce est celui du sondage. C'est le code actuel, inchangé, y compris `closePoll` et le récap. En mode test (annonce sur un autre groupe), on prend toujours le nouveau chemin, même avec la mention (spec §4.7, P1-5).
- **legacy** aussi si `job.pollMsgId` est nul : impossible alors de rattacher les événements (P2-11).
- **nouveau** sinon :
  1. `integratedEventIds = await listPollVoteEventIds(db, { chatJid: bookingRule.whatsappGroupJid, pollMsgId })`, **avant** `resolveVotes` (R2-1). `bookingRule` de l'état est la copie de la règle prise par le job, donc le groupe d'envoi ;
  2. `resolveVotes`, puis la garde de lecture vide, inchangée ;
  3. dans l'action `withEventLogging`, `saveRosterPhoto(db, jobRunId, { capturedAt, integratedEventIds, voters }, identities)`. Un échec met l'étape en erreur, comme une lecture ratée ;
  4. aucun `deleteMessage`, aucun désépinglage du sondage ;
  5. `sendTelegramSummaries`, inchangé ;
  6. `publishRoster` du texte provisoire, construit à partir de `photoState`, sur `resolveAnnounceNotifyJid`, avec `pinEnabled = bookingRule.pinMessagesEnabled`. Best-effort : un résultat `"failed"` est déjà signalé par `publishRoster`.

- [ ] **Step 1 : tests qui échouent** (dans `collectVotes.test.ts`, en mockant `../../roster/rosterStore.js` et `../../roster/publishRoster.js`) :
  - `CA-1 : sondage conservé, pas de deleteMessage ni d'unpin du sondage, roster provisoire publié`
  - `R2-1 : listPollVoteEventIds appelé avant resolveVotes` (ordre des appels)
  - `photo enregistrée avec votedAt et téléphones normalisés`
  - `collecte legacy inchangée si la question annonce la clôture` (Review Focus 1) : `deleteMessage` est appelé, le récap est envoyé, `saveRosterPhoto` ne l'est pas.
  - `pollMsgId nul → chemin legacy` (P2-11, PC1-9)
  - `lecture vide : toujours une erreur, rien publié`
  - Dans `resolveVotes.test.ts` : `photoVoters inclut votedAt et les « Non »`.
- [ ] **Step 2 : lancer.** Attendu : FAIL.
- [ ] **Step 3 : implémenter.** Trois tests existants changent de sens, parce que la spec change le comportement d'un sondage sans mention (§4.7). Ils sont **réécrits** en tests du nouveau chemin (P1-4, P1-5), sans être supprimés :
  - `collectVotes.test.ts:273` (« sondage sans mention… désépinglage seul ») devient `question sans marqueur : sondage conservé et épinglé, roster provisoire` ;
  - `:521` (« ancien sondage sans marqueur : 📋 Inscrits ») devient `question sans marqueur : roster provisoire « 📋 Inscrits »` ;
  - les tests du mode test (`:283`, `:545`), si leur question porte la mention, deviennent `mode test avec mention : nouveau chemin, sondage non désépinglé`.

  Les autres tests existants du chemin de suppression doivent rester verts. Ils construisent des sondages dont la question contient la clôture (`QUESTION_WITH_CLOSURE`), donc ils couvrent maintenant le chemin legacy. Si un test existant échoue parce qu'il suppose une question sans clôture **et** une suppression, le passer en legacy par sa fixture. On ne le supprime pas, et sa valeur attendue n'est pas modifiée.
- [ ] **Step 4 : lancer** `npm run worker:test` (tout le worker) et le typecheck. Attendu : PASS.
- [ ] **Step 5 : commit.** `feat(collecte): sondage conservé, photo des votes et roster provisoire`.

---

### Task 9 : BookSlots, les votes tardifs entrent dans le plan (CA-2, §4.3, R1-4)

**Files :**
- Modify : `apps/worker/src/graph/nodes/bookSlots.ts`
- Modify : `apps/worker/src/scheduler/scheduler.ts` (`refreshUnresolvedVoters` : mémoriser les identifications)
- Create : `apps/worker/src/roster/refreshVotes.ts`
- Modify : `apps/worker/src/graph/unresolvedVoters.ts` (`RelookupResult.identified` gagne `phone`, `userId`) (P2-15). Test : `apps/worker/src/graph/unresolvedVoters.test.ts`, `identified porte phone et userId` (PC1-9)
- Test : `apps/worker/src/roster/refreshVotes.test.ts`, `apps/worker/src/graph/nodes/bookSlots.test.ts`, `apps/worker/src/scheduler/scheduler.test.ts`

**Interfaces :**
- Consumes : tâches 2 et 3, `lookupPlayerByPhone`, `playerMessageName`.
- Produces : `refreshVotesFromEvents(deps: Pick<GraphDependencies,"db"|"resaSquash"|"telegram">, job: JobRun, rule: BookingRule, ruleLabel: string): Promise<{ resolved: ResolvedVotes; snapshot: RosterPlanSnapshot } | null>`. Elle renvoie null si `job.rosterPhoto` est nul (legacy). Dans l'ordre :
  1. `listPollVoteEvents` ;
  2. `applyVoteEvents` depuis `{ state: photoState(photo), integratedEventIds: photo.integratedEventIds }` ;
  3. pour chaque clé `tel:` absente de `identities`, **un seul** `lookupPlayerByPhone`. S'il échoue ou ne trouve personne : `{ userId: null, name: actorName ?? waName de la photo ?? phone }`. Une clé `nom:` ou `jid:` absente de `identities` reçoit, sans lookup, `{ userId: null, name: waName de la photo ?? actorName ?? "" }` (PC2-2). L'affichage passe toujours par `publicVoterName`, qui donne « un joueur » pour un nom vide. Puis `mergeRosterIdentities(…, "keep")`. Un « Non » de la photo qui revote « oui » est un votant nouveau au sens de cette recherche : il est absent de `identities` (P2-1). C'est un écart assumé avec la formulation « absent de la photo » de la spec §4.2, qui sert CA-2 (PC1-4) ;
  4. Telegram, une fois par `event_id`, pour `suspiciousDeletions` et `unmatchedNoPhone`. Le texte nomme le votant (nom WhatsApp, JID) (C3-4) ;
  5. `toResolvedVotes`.

  `snapshot = { tPlan: now.toISOString(), state, integratedEventIds }`.

**Branchements :**
- Au début de `createBookSlotsNode`, lire le job. Si `refreshVotesFromEvents` renvoie un résultat, utiliser `resolved` à la place des champs de vote de l'état, renvoyer ces champs dans la mise à jour d'état, puis `saveRosterPlanSnapshot(snapshot)` une fois le plan calculé.
- Décision P1-2, option A : `RelookupResult.identified` (`apps/worker/src/graph/unresolvedVoters.ts`) passe à `Array<{ name: string; option: string; phone: string | null; userId: string }>`. C'est un ajout de champs, sans changement du comportement ni du Telegram.
- `refreshUnresolvedVoters(rule, job, status, resaSquash, telegram, db)` : la signature reçoit `job` et `db`, et `triggerRecomputePlan` les passe. Pour un job avec `rosterPhoto`, chaque `identified` dont le `phone` est connu est écrit dans les identités (`mergeRosterIdentities(…, "override")`, clé `` `tel:${normalizePhone(phone)}` ``, `{ userId, name }`, P2-12) **avant** `graph.updateState`. BookSlots, qui suit, retrouve donc ces identifications et ne les écrase pas (R1-4).

- [ ] **Step 1 : tests qui échouent.**
  - `CA-2 : un oui arrivé après la collecte est dans confirmedPlayerIdsByTime du plan`
  - `CA-2 : un « Non » à la collecte qui revote oui est cherché (lookup) et entre dans le plan au « Calculer »` (P2-1)
  - `snapshot enregistré : tPlan, état et event_id intégrés`
  - `R1-4 : identifié par Recalculer → reste identifié après le recalcul des votes` (scheduler + refreshVotes)
  - `lookup seulement pour un votant nouveau ; un échec mémorise le nom WhatsApp` : deux appels successifs donnent un seul `lookupPlayerByPhone`.
  - `faux retrait et @lid non rapproché : un Telegram par event_id, pas à chaque passe`
  - `job legacy : bookSlots inchangé` (aucun appel à rosterStore)
- [ ] **Step 2 : lancer.** Attendu : FAIL.
- [ ] **Step 3 : implémenter.** Telegram dédupliqué : un `Set` en mémoire dans `refreshVotes.ts`, plus `__reset…ForTests`.
- [ ] **Step 4 : lancer** tout le worker et le typecheck. Attendu : PASS.
- [ ] **Step 5 : commit.** `feat(plan): les votes reçus après la collecte entrent dans le plan`.

---

### Task 10 : Announce, le roster définitif remplace l'annonce (CA-3, §4.5)

**Files :**
- Modify : `apps/worker/src/graph/nodes/announce.ts` (`createAnnounceNode`)
- Create : `apps/worker/src/roster/finalRoster.ts`
- Test : `apps/worker/src/roster/finalRoster.test.ts`, `apps/worker/src/graph/nodes/announce.test.ts`

**Interfaces :**
- Produces :
  - `buildRosterFinal(input: { snapshot: RosterPlanSnapshot; groups: BookingPlanGroup[]; failures: ReservationFailure[]; candidateStartTimes: string[]; realBooking: boolean; title: string; courtsBlock: string; failuresNote: string; capacityNote: string }): RosterFinal`. Pour chaque heure candidate ayant au moins un « oui » dans `snapshot.state`, `capacity` vaut :
    - le nombre de « oui » à cette heure, si le groupe du plan de même `startTime` a au moins une réservation réellement prise (`reservedBookings` filtré sur ce groupe : ni refusée, ni hors fenêtre) ;
    - **0** sinon (R1-5).
  - `computeLiveRosters(deps: Pick<GraphDependencies,"db"|"resaSquash"|"telegram">, job: JobRun, rule: BookingRule, ruleLabel: string, opts?: { final?: RosterFinal }): Promise<{ text: string; phase: RosterPhase; rosters: HourRoster[]; identities: Identities } | null>`. Ici, `rule` est **la copie de la règle prise par le job** (`status.values.bookingRule ?? job.ruleSnapshot`) : groupe du sondage et heures candidates (`job.candidateStartTimes ?? rule.candidateStartTimes`). La règle live ne sert qu'au libellé (P1-9). Pour un job avec `opts.final ?? job.rosterFinal` :
    1. `listPollVoteEvents` ;
    2. `applyVoteEvents` depuis `final.base` ;
    3. lookup des nouveaux et Telegram, comme `refreshVotesFromEvents`. Extraire de la tâche 9 un helper commun `resolveNewIdentities` dans `refreshVotes.ts` ;
    4. `initialRosters(final.hours, final.base.state, (key) => rosterDisplayName(key, identities))`, puis `applyMoves(…, applied, candidateStartTimes)` (P2-4) ;
    5. `buildFinalRosterMessage`.

    Pour un job **sans** `rosterFinal` mais avec `rosterPhoto` : le texte provisoire, à partir de l'état photo plus événements, avec le même `resolveNewIdentities` (un « Non » passé à « oui » est affiché par son nom, PC1-5), et `rosters: []`. Null pour un job legacy.

**Dans `createAnnounceNode`**, si `job.rosterPlanSnapshot` existe :
- l'annonce n'est plus envoyée par `sendMessage` ;
- calculer `title`, `courtsBlock` (`formatMergedCourtSlots(merged)`), `failuresNote` et `capacityNote` comme aujourd'hui, puis `saveRosterFinal(buildRosterFinal(...))` ;
- publier `computeLiveRosters(...).text` avec `publishRoster`, qui remplace le provisoire. Un résultat `"failed"` **lève une erreur**, comme l'échec actuel de `sendMessage` de l'annonce ;
- ne pas appeler `setJobRunAnnounceInfo` ni l'épinglage de l'annonce ;
- les QR, la synthèse du groupe test et le Telegram restent inchangés ;
- `announceMessage` **et** `detail.message` de l'événement `booking` (`step: "announced"`) reçoivent le texte du roster (P1-20) ;
- le texte définitif est calculé à partir du `RosterFinal` qu'on vient de construire, passé directement à `computeLiveRosters` via une option `{ final }`, sans relire le job (P1-21) ;
- `publishRoster(…, "final")` ;
- l'échec total reste inchangé : message d'échec, erreur levée.

Sans `rosterPlanSnapshot` (legacy), le code reste celui d'aujourd'hui.

- [ ] **Step 1 : tests qui échouent.**
  - `buildRosterFinal : heure avec créneau pris → capacity = nb de oui`
  - `buildRosterFinal : heure dont tous les créneaux sont refusés → capacity 0` (R1-5)
  - `buildRosterFinal : heure dont le seul votant a été déplacé (groupe vide) → capacity 0`
  - `CA-3 : announce publie le roster définitif (créneaux, (n/cap), pied de désistement) à la place de l'annonce` : `sendMessage` n'est jamais appelé avec le titre seul, et `publishRoster` reçoit un texte qui contient `Pour te désister`.
  - `dry-run : roster définitif publié avec le titre dry-run` (décision R1-6)
  - `annonce legacy inchangée sans rosterPlanSnapshot`
  - `publishRoster "failed" → erreur levée`
  - `computeLiveRosters : un vote après le plan est appliqué (attente), jamais réécrit au tick suivant` : deux appels avec les mêmes événements donnent le même texte.
- [ ] **Step 2 : lancer.** Attendu : FAIL.
- [ ] **Step 3 : implémenter.**
- [ ] **Step 4 : lancer** tout le worker et le typecheck. Attendu : PASS.
- [ ] **Step 5 : commit.** `feat(annonce): le roster définitif remplace l'annonce des courts`.

---

### Task 11 : tick du roster, republication, fin et retrait (CA-9, CA-10, §4.7, C3-3)

**Files :**
- Create : `apps/worker/src/scheduler/rosterTick.ts`
- Modify : `apps/worker/src/scheduler/scheduler.ts` (`runMinuteTick` appelle `triggerRosterRefresh`, en catch séparé comme les deux autres ; `triggerRecapUnpins` est inchangé)
- Test : `apps/worker/src/scheduler/rosterTick.test.ts`

**Interfaces :**
- Consumes : `computeLiveRosters` (tâche 10), `publishRoster`, `withdrawRoster` et `retryOrphanUnpin` (tâche 6), `listJobsWithRoster`, `listJobsWithRosterOrphan` et `listJobsWithPinnedPoll` (tâche 2), `isRecapUnpinDue` et `isRecapUnpinStale` (`apps/worker/src/scheduler/recapUnpin.ts`), `getJobExecutionStatus`, `findActiveJobRunForDate`, `firstReservedSlotMinutes`, `parisMinutesNow`, `computeTargetDate`, `resolveAnnounceNotifyJid`.
- Produces : `triggerRosterRefresh(now: Date, graph: PipelineGraph, telegram: TelegramConfig, db: Database, huddleBot: McpConnection, resaSquash: McpConnection): Promise<void>`.

**Pour chaque job de `listJobsWithRoster(db, computeTargetDate(now, -RECAP_UNPIN_ABANDON_DAYS))`**, avec un try/catch par job. La borne basse est 7 jours en arrière, pour que la fin d'un job dont le pod était arrêté le jour du match soit rattrapée (P2-9). Seule l'étape 3 s'applique à une date passée : aucune publication.
1. Ignorer le job s'il n'est pas le job actif de sa règle pour sa date (`findActiveJobRunForDate`).
2. Lire `status = getJobExecutionStatus(rule, job, graph)`.
3. **Fin (CA-10).** Si `stage === "finished-announced"`, que `firstReservedSlotMinutes(...)` n'est pas null, et que l'on a soit `targetDate < today` (rattrapage d'un pod arrêté, P2-9), soit `targetDate === today` avec `parisMinutesNow(now) >= ` ce premier créneau :
   - désépingler le roster courant (si `rosterPinnedAt`). En cas d'échec, il est mémorisé comme orphelin (`setRosterOrphan`), pour que la passe des orphelins réessaie (P1-14) ;
   - `setRosterStoppedAt` ;
   - rien n'est publié.

   Un `firstReservedSlotMinutes` null relève de l'étape 4 (P1-15). Le sondage est traité par la passe dédiée ci-dessous.
4. **Fin sans réservation.** Si `stage` vaut `finished-no-plan`, `finished-cancelled` ou `error`, ou si c'est `finished-announced` sans créneau réservé : `withdrawRoster` si `rosterMsgId` existe, sinon rien.
5. **Publication.** Si `stage` vaut `awaiting-plan` ou `awaiting-go`, ou si c'est `finished-announced` avec `rosterFinal` :
   - `computeLiveRosters`, avec la copie de la règle prise par le job (P1-9) ;
   - `publishRoster(text, phase)` sur `resolveAnnounceNotifyJid(deps, copie de la règle)`, qui relit lui-même la règle live, avec `pinEnabled` = `pinMessagesEnabled` de la copie de la règle.

**Ensuite, pour chaque job de `listJobsWithRosterOrphan`**, quel que soit son état (C3-3) : `retryOrphanUnpin`.

**Ensuite, passe sondage (P1-3)** : pour chaque job de `listJobsWithPinnedPoll`, sans filtre de date ni d'état :
- si la copie de la règle n'a pas `pinMessagesEnabled` : `setPollUnpinnedAt(now)` sans appel à huddle-bot, pour qu'il ne soit plus resélectionné (P2-13) ;
- si `isRecapUnpinStale(targetDate, now)` : `setPollUnpinnedAt(now)` sans appel à huddle-bot ;
- sinon, si `isRecapUnpinDue({ targetDate, firstReservedSlotMinutes (null sans créneau, donc 23h59), cancelled, now })` : `unpinMessage(groupe du sondage, pollMsgId)`. `setPollUnpinnedAt` n'est écrit **qu'en cas de réussite**. Un échec donne un Telegram dédupliqué et un nouvel essai au tick suivant.

Le job reste sélectionné par `listJobsWithPinnedPoll` même après `roster_stopped_at`.

- [ ] **Step 1 : tests qui échouent.**
  - `CA-9 : un vote change → nouveau roster publié via publishRoster`
  - `aucun changement → publishRoster renvoie "unchanged", aucun envoi` (anti-objectif 2)
  - `CA-10 : après le début du 1er créneau → aucune publication, roster désépinglé, roster_stopped_at écrit ; sondage désépinglé par la passe sondage`
  - `CA-10 : désépinglage du roster en échec à la fin → orphelin mémorisé, retenté ensuite` (P1-14)
  - `passe sondage : job sans créneau → sondage désépinglé à 23h59` (P1-3)
  - `passe sondage : date passée → désépinglé au rattrapage ; échec → poll_unpinned_at non écrit` (P1-3)
  - `firstReservedSlotMinutes null → traité comme fin sans réservation` (P1-15)
  - `la copie de la règle du job sert au filtre des événements, pas la règle live` (P1-9)
  - `job non actif pour la date → ignoré`
  - `finished-no-plan → roster provisoire retiré (withdrawRoster)` (R1-16)
  - `Recalculer depuis finished-cancelled → awaiting-go → provisoire republié` (R2-11)
  - `orphelin d'un job terminé → désépinglage retenté` (C3-3)
  - `lookup en échec : nom WhatsApp mémorisé, pas de republication au tick suivant` (Review Focus 3)
- [ ] **Step 2 : lancer.** Attendu : FAIL.
- [ ] **Step 3 : implémenter**, puis le branchement dans `runMinuteTick`.
- [ ] **Step 4 : lancer** tout le worker et le typecheck. Attendu : PASS.
- [ ] **Step 5 : commit.** `feat(roster): tick à la minute, republication et fin au premier créneau`.

---

### Task 12 : annulation du sondage et fermeture PUC après la collecte (R1-8, R2-2)

**Files :**
- Modify : `apps/worker/src/http/server.ts` (garde-fou d'annulation)
- Modify : `apps/worker/src/closures/cancelJobForClosure.ts`
- Test : `apps/worker/src/http/server.test.ts`, `apps/worker/src/closures/cancelJobForClosure.test.ts`

**Comportement :**
- **Annulation manuelle.** En plus de `job.pollClosedAt`, renvoyer 409 si `findLastSuccessfulEvent(db, job.id, "collect_votes")` existe. Message : `"Votes déjà collectés — annulation du sondage impossible."`
- **`cancelJobForClosure`, pour un job avec `rosterPhoto`** :
  - âge du sondage = `now − createdAt` de l'événement `poll` (`findLastSuccessfulEvent`) ;
  - moins de 48 h : `deleteMessage` sur `job.ruleSnapshot?.whatsappGroupJid ?? rule.whatsappGroupJid`. `pollDeleted = true` seulement en cas de réussite. En cas d'échec : désépinglage best-effort, et `pollDeleted = false`, donc « Ignorez le sondage du coup » (PC2-3) ;
  - 48 h ou plus, ou date inconnue : `unpinMessage` best-effort si la copie de la règle prise par le job épingle, `pollDeleted = false` (le message dit alors « Ignorez le sondage du coup ») ;
  - `setPollUnpinnedAt(now)` seulement si la suppression **ou** le désépinglage a réussi (P2-8, PC1-7). Un sondage supprimé n'a plus d'épinglage. Après un échec, la passe sondage de la tâche 11 réessaie le désépinglage, puisque le job annulé reste sélectionné ;
  - puis `withdrawRoster` avec le contexte de la copie de la règle prise par le job, retenté jusqu'à 3 fois s'il renvoie `false` (claim pris), puis Telegram (tâche 6, P2-5).

  Tests supplémentaires : `sondage < 48 h dont la suppression échoue → « Ignorez le sondage du coup »` (PC2-3), `withdrawRoster pris 3 fois → Telegram` et `suppression et désépinglage du sondage en échec → poll_unpinned_at non écrit` (PC1-6, PC1-7).
  - Le reste (message, annulation, événement) est inchangé.
- Job legacy : le code est inchangé.

- [ ] **Step 1 : tests qui échouent.**
  - `annulation refusée après collect_votes réussi (409)`
  - `fermeture PUC après collecte, sondage < 48 h → supprimé, « J'ai supprimé le sondage », roster retiré`
  - `fermeture PUC après collecte, sondage ≥ 48 h → désépinglé, « Ignorez le sondage du coup », roster retiré`
  - `fermeture PUC legacy inchangée`
- [ ] **Step 2 : lancer.** Attendu : FAIL.
- [ ] **Step 3 : implémenter.**
- [ ] **Step 4 : lancer.** Attendu : PASS.
- [ ] **Step 5 : commit.** `fix(annulation): garde-fous du sondage conservé (annulation, fermeture PUC)`.

---

### Task 13 : la confirmation et le rappel listent les inscrits du roster (§4.8)

**Files :**
- Modify : `apps/worker/src/graph/nodes/announce.ts` (`buildBookingConfirmationMessage` : nouveau paramètre optionnel en fin de liste, `inscritsByTime?: Record<string, string[]>`)
- Modify : `apps/worker/src/scheduler/scheduler.ts` (`triggerBookingConfirmation`, `sendStartReminderIfDue`)
- Test : `apps/worker/src/graph/nodes/announce.test.ts`, `apps/worker/src/scheduler/scheduler.test.ts`

**Comportement :**
- Si `inscritsByTime` est fourni, le bloc devient `\n\nInscrits :\n` suivi d'une ligne `• <heure> : <noms>` par heure ayant au moins un inscrit, dans l'ordre de `candidateStartTimes`.
- Sinon, le bloc « Oui au sondage » actuel reste.
- Les deux appelants calculent `inscritsByTime` avec `rosterInscritsByTime(computeLiveRosters(...).rosters, identities)` quand `job.rosterFinal` existe. Ils passent à `computeLiveRosters` la copie de la règle prise par le job (`status.values.bookingRule ?? job.ruleSnapshot ?? rule`), pas la règle live (P2-12). En cas d'échec de ce calcul, on retombe sur l'ancien bloc et on logue en console.

- [ ] **Step 1 : tests qui échouent.**
  - `confirmation avec roster : « Inscrits : », Hugo2 présent, Henry absent`
  - `rappel avant match avec roster : idem`
  - `sans roster : « Oui au sondage » inchangé`
- [ ] **Step 2 : lancer.** Attendu : FAIL.
- [ ] **Step 3 : implémenter.**
- [ ] **Step 4 : lancer** tout le worker et le typecheck. Attendu : PASS.
- [ ] **Step 5 : commit.** `feat(confirmation): confirmation et rappel alignés sur le roster`.

---

### Task 14 : documentation (ADR-038, règles fonctionnelles, graphe)

**Files :**
- Create : `docs/adr/ADR-038-sondage-conserve-roster-vivant.md`
- Modify : `docs/adr/README.md` (index), `docs/adr/ADR-037-cloture-sondage-suppression-collecte.md` et `docs/adr/ADR-034-epinglage-whatsapp-sondage-annonce.md` (une ligne « Amendé par ADR-038 » en tête ; le corps n'est pas réécrit)
- Modify : `docs/spec/regles-fonctionnelles.md`

- [ ] **Step 1 : ADR-038.** Format des ADR voisins : Contexte (incident du 2026-10-24), Décision (§4 de la spec résumé), Alternatives écartées (lecture de `get_responses` à chaque vote ; édition en place ; republication quotidienne), Conséquences : migration 0034, risques du §7 de la spec, et C3-1 : au plus 2 épinglés, où le roster épinglé peut être l'orphelin.
- [ ] **Step 2 : règles fonctionnelles.** Y écrire aussi la règle « un « Non » de la collecte qui revote oui est recherché dans resa-squash », qui précise la spec §4.2 (PC1-4, PC2-4). L'ADR-038 la mentionne aussi. Mettre à jour les sections listées au §5 de la spec :
  - §2 : la question ;
  - §3 : collecte, roster provisoire, garde-fou d'annulation, recours de la lecture vide ;
  - §6 : roster définitif, épinglage, confirmation, rappel ;
  - nouvelle sous-section « Roster vivant » : règles §4.6, publication §4.7, cas legacy.

  Chaque règle est datée du 2026-10-25 et renvoie à ADR-038.
- [ ] **Step 3 : vérifier** que les textes cités dans les règles sont identiques à ceux des tests des tâches 5, 12 et 13 (relecture croisée par `grep`).
- [ ] **Step 4 : lancer** `graphify update .`, puis `npm test` et `npm run typecheck` (suite complète). Attendu : PASS, avec au moins 686 tests plus les nouveaux, et 0 échec.
- [ ] **Step 5 : commit.** `docs: ADR-038 et règles fonctionnelles du roster vivant`.

---

## Couverture spec → tâches

| Spec | Tâche(s) |
|---|---|
| §4.1 sondage conservé, épinglage, annulation, PUC | 7, 8, 11, 12 |
| §4.2 photo, événements, identité, `@lid`, faux retrait | 3, 8, 9 |
| §4.3 votes tardifs dans le plan, ordre recalcul | 9 |
| §4.4 roster provisoire | 5, 8, 11 |
| §4.5 roster définitif, heure sans court, dry-run | 5, 10 |
| §4.6 attribution | 4 |
| §4.7 publication, orphelin, fin, jobs legacy | 6, 11, 8 |
| §4.8 confirmation et rappel | 13 |
| §5 données et documentation | 2, 14 |
| §7 risques | 3, 9, 14 |
| CA-1 … CA-11 | 8 ; 9 ; 5, 10 ; 4 (CA-4 à CA-8) ; 6, 11 (CA-9) ; 11 (CA-10) ; 2, 3 (CA-11) |
| C3-1 / C3-2 / C3-3 / C3-4 (mineurs de la spec) | 14 / 6 / 6, 11 / 9 |
