# Design — Fermeture PUC déclarée tardivement (arrêt des jobs en cours)

**Date** : 2026-09-12  
**Statut** : validated (brainstorming)  
**Approche** : le worker porte la création de fermeture + cascade d'arrêt, l'UI `/settings` passe en formulaire à deux temps (aperçu d'impact → confirmation)  
**Complète** : [2026-08-09-club-closures-design.md](2026-08-09-club-closures-design.md)

## Problème

Les fermetures PUC (`club_closures`) ne sont consultées qu'au moment du SendPoll. Quand on apprend une fermeture **après** le lancement du sondage (ex. tournoi samedi 19 septembre 2026, sondage déjà parti), le job continue : collecte des votes, plan, demande de « go », annonce. Il faut pouvoir déclarer la fermeture et que cela **arrête le job en cours**, **supprime le sondage WhatsApp** et **prévienne le groupe** avec la raison, sur un ton informel.

## Objectifs

1. À l'ajout d'une fermeture dans `/settings`, montrer les jobs en cours et prévus impactés, puis demander une **confirmation explicite** avant tout effet.
2. Après confirmation, pour chaque job en cours impacté : supprimer le sondage WhatsApp, envoyer un message « mode pote » au groupe avec la raison, annuler le job avec la cause, journaliser (événement + Telegram).
3. Le message envoyé au SendPoll quand la date cible est déjà fermée devient informel et porte la raison.
4. Empêcher qu'un « go » Telegram reçu après l'arrêt reprenne le graphe d'un job annulé.
5. Mettre à jour `docs/spec/regles-fonctionnelles.md` dans le même commit.

## Non-objectifs

- Annuler des réservations TeamR déjà prises (`cancel_reservation`). Décision : soit le club n'est pas réservable, soit l'administrateur du PUC supprime lui-même les réservations.
- « Ressusciter » un job annulé quand on supprime une fermeture.
- Recalculer un sondage en cours pour retirer seulement les heures fermées (une fermeture partielle arrête le job, voir Règles).
- Sélection fine, dans l'aperçu, des jobs à arrêter ou non : la confirmation porte sur la fermeture, tout job impacté est arrêté.
- Modifier huddle-bot ou resa-squash : on n'utilise que `delete_message` et `send_message`, déjà exposés.

## Règles fonctionnelles (résumé, à reporter dans la spec)

- **Job impacté (« en cours »)** : job non annulé, sondage envoyé, non terminé — stage `awaiting-decision`, `awaiting-plan` ou `awaiting-go` — dont **au moins une** heure candidate (celles du job, repli sur celles de la règle) tombe dans l'intervalle de fermeture. Une fermeture partielle qui couvre une heure candidate arrête le job **autant** qu'une fermeture journée entière.
- **Job prévu** : job `not-started` dont au moins une heure candidate est couverte, ou règle active sans job pour cette date cible dont le prochain jour cible (`nextWeekdayDate`) tombe dans l'intervalle avec au moins une heure candidate couverte. Listé pour information : rien à annuler, le message de fermeture partira à la place du sondage (comportement SendPoll existant).
- **Jamais touchés** : stages `finished-*`, jobs déjà annulés. Un job en stage `error` couvert est listé dans l'aperçu avec la mention « en erreur — à annuler à la main », sans action automatique.
- **Libellé obligatoire** à la création (formulaire + route). Les fermetures existantes sans libellé restent valides ; leurs messages omettent la raison.
- **Réservations TeamR jamais touchées** par cette fonctionnalité.
- Supprimer une fermeture n'a aucun effet sur les jobs déjà annulés.

## Données

### `job_runs` — deux colonnes

| Colonne | Type | Notes |
|---------|------|-------|
| `cancel_reason` | text nullable | `PUC fermé : <libellé>` posé par la cascade. L'annulation manuelle existante (`cancelPollAction`) laisse `null`. |
| `club_closure_id` | uuid nullable, FK `club_closures(id)` `ON DELETE SET NULL` | Trace de la fermeture à l'origine de l'arrêt. Historique uniquement, aucun comportement associé. |

Migration Drizzle dans `packages/db/src/migrations/` (appliquée automatiquement par l'initContainer, ADR-012).

### Événements

Pas de nouveau type : réutiliser `club-closed` avec un `detail` enrichi :
`{ closureId, label, stage, pollDeleted: boolean, message, closedTimes }`.
Statut `error` si la cascade a échoué sur ce job (détail : étape et message d'erreur).

### `loadClubClosuresForDate`

Renvoie désormais aussi `label` (`ClosureInterval` gagne `label: string | null`). `filterCandidateTimesByClosures` reste inchangé (ignore le libellé).

## Détection d'impact (worker)

Nouveau module `apps/worker/src/closures/closureImpact.ts`.

```ts
interface ClosureImpactEntry {
  ruleId: string;
  ruleLabel: string;        // nom du groupe / de la règle pour l'UI
  jobId: string | null;     // null pour une règle sans job encore créé
  targetDate: string;
  stage: PipelineStage | "not-created";
  closedTimes: string[];
}
interface ClosureImpact {
  running: ClosureImpactEntry[];   // seront arrêtés
  planned: ClosureImpactEntry[];   // information seulement
  errored: ClosureImpactEntry[];   // stage "error", à traiter à la main
}
```

- `computeClosureImpact(interval, rules, jobsWithStatus, now)` : **fonction pure**, testable sans MCP ni DB. Pour chaque job : heures candidates = `job.candidateStartTimes ?? rule.candidateStartTimes`, `closedTimes` via `filterCandidateTimesByClosures(targetDate, times, [interval])`. Impact ssi `closedTimes.length > 0`.
- `loadClosureImpact(deps, interval)` : charge les règles actives, leurs jobs non annulés, le statut LangGraph de chacun (`getJobExecutionStatus`), puis appelle la fonction pure. Ne considère que les jobs dont `targetDate` est dans `[startsAt − 1 jour, endsAt + 1 jour]` (Paris) pour ne pas interroger Redis pour tout l'historique.

## API interne du worker (`apps/worker/src/http/server.ts`)

### `POST /club-closures/preview`

Body `{ startsAt: string; endsAt: string }` (ISO 8601). Validation `endsAt > startsAt`. Lecture seule. Réponse `200 ClosureImpact`.

### `POST /club-closures`

Body `{ startsAt: string; endsAt: string; label: string }`. Validation : `endsAt > startsAt`, `label.trim()` non vide (sinon `400`).

Enchaînement :

1. Insérer la fermeture (`club_closures`).
2. Recalculer l'impact **au moment de la confirmation** (pas celui de l'aperçu) : tout job `running` est arrêté, même s'il n'apparaissait pas dans l'aperçu.
3. Pour chaque job `running` : `cancelJobForClosure` (ci-dessous). L'échec d'un job n'arrête pas les autres.
4. Réponse `200 { closureId, cancelled: ClosureImpactEntry[], failed: Array<{ jobId, ruleId, error }>, planned, errored }`.

La suppression de fermeture reste la server action UI existante (`deleteClubClosureAction`), inchangée. La création directe en base depuis l'UI (`createClubClosure`) est supprimée au profit de la route worker.

## Cascade d'arrêt par job — `cancelJobForClosure`

Module `apps/worker/src/closures/cancelJobForClosure.ts`, dépendances injectées (`GraphDependencies` + Telegram), ordre strict :

1. **Supprimer le sondage** : si `job.pollMsgId` présent → `delete_message(groupJid, pollMsgId)`. Échec ou `pollMsgId` absent : on **continue**, `pollDeleted = false`.
2. **Message WhatsApp** au groupe de la règle : `buildClosureCancelMessage(targetDate, labels, pollDeleted)`.
3. **Annuler le job** : `cancelJobRun` étendu pour poser `cancelledAt`, `cancelReason = "PUC fermé : <libellé>"`, `clubClosureId`.
   L'annulation est faite **même si** l'étape 2 a échoué (le job ne doit pas continuer), et l'erreur est remontée dans `failed`.
4. **Événement** `club-closed` (`success` ou `error`) avec le détail décrit plus haut.
5. **Log Telegram** :
   `[ruleId] PUC fermé le <date> (<libellé>) — job <jobId> arrêté à l'étape <stage>, sondage supprimé : oui|non`.

Le thread LangGraph reste en pause sur son interrupt : les crons et `recoverPendingGoWaits` ignorent déjà les jobs annulés (`cancelledAt`), `computeStage` ne change pas, aucun `updateState`. La page du job affiche « ✗ Job annulé le … — PUC fermé : <libellé> » (voir UI).

### Garde-fou « go » Telegram (obligatoire)

Dans `awaitGoAndResume` (scheduler.ts), après le retour de `waitForGoConfirmation` : **relire le job en base** et, s'il est annulé, ne pas appeler `graph.invoke` ; log Telegram `[ruleId] "go" ignoré — job du <date> annulé (<cancelReason ?? "annulation manuelle">)`. Le « go » consommé n'est pas rejoué (offset Telegram déjà persisté, comportement existant).

Vérifier que les routes de déclenchement manuel (collect, plan, go, retry, force-go) répondent `409` sur un job annulé — le garde-fou existe pour certaines, à généraliser.

## Messages WhatsApp (`apps/worker/src/graph/nodes/pollQuestion.ts`)

Ton informel, « mode pote ». `formatInformalDate` existant (« samedi 19 septembre »). Raison = libellés des fermetures couvrant la date, dédupliqués, joints par « / » ; parenthèse omise si aucun libellé.

- **Arrêt d'un job en cours**, sondage supprimé :
  `Hello la team ! Mauvaise nouvelle : le PUC est fermé samedi 19 septembre (tournoi), donc pas de squash ce jour-là 😕 J'ai supprimé le sondage, on remet ça la semaine prochaine 💪`
- **Arrêt d'un job en cours**, sondage non supprimable :
  `Hello la team ! Mauvaise nouvelle : le PUC est fermé samedi 19 septembre (tournoi), donc pas de squash ce jour-là 😕 Ignorez le sondage du coup, on remet ça la semaine prochaine 💪`
- **Job qui démarre sur une date déjà fermée** (remplace `puc fermé … pas de squash` — `buildClubClosedMessage` prend maintenant les libellés) :
  `Hello la team ! Le PUC est fermé samedi 19 septembre (tournoi), donc pas de squash ce jour-là 😕 Pas de sondage cette semaine, on remet ça la semaine suivante 💪`
- Fermeture partielle au démarrage (cas B du design 2026-08-09) : question de sondage inchangée.

## UI `/settings`

`ClubClosureAddForm` devient un composant en deux temps (client, état contrôlé, même pattern que `GoConfirmationForm`) :

1. **Saisie** : mode « Toute la journée » / horaires précis (existant) + libellé **obligatoire** (`required`). Bouton « Vérifier l'impact » → server action `previewClubClosureAction` (appelle `POST /club-closures/preview` via `callWorker`) ; le résultat est renvoyé au composant (pas de rechargement de page).
2. **Aperçu** sous le formulaire :
   - « Jobs en cours — seront arrêtés » : groupe, date cible, étape, heures fermées ; avertissement « le sondage WhatsApp sera supprimé et le groupe prévenu ».
   - « Jobs prévus » : groupe, date cible ; mention « recevra le message de fermeture à la place du sondage ».
   - « Jobs en erreur » : groupe, date cible ; mention « à annuler à la main depuis la page du job ».
   - Aucun impact : « Aucun job concerné ».
   - Boutons **« Confirmer la fermeture »** (style danger si `running` non vide) et « Annuler » (retour à la saisie, valeurs conservées).
3. **Confirmation** → server action `confirmClubClosureAction` (appelle `POST /club-closures`), puis `revalidatePath("/settings")` et affichage d'un récapitulatif : fermeture ajoutée, jobs arrêtés, échecs éventuels avec le message d'erreur.

Lecture seule si non-admin (pattern existant `requireAdmin`).

Page du job (`Pipeline.tsx`) : la ligne « ✗ Job annulé le … (sondage supprimé) » devient « ✗ Job annulé le … — <cancelReason> » quand la raison est renseignée, formulation existante sinon. `PipelineStage` côté UI inchangé.

## Architecture (unités)

| Unité | Rôle | Dépend de |
|-------|------|-----------|
| `packages/db` migration + schéma | colonnes `cancel_reason`, `club_closure_id` | — |
| `closures/closureImpact.ts` (pur) | `computeClosureImpact` | `filterCandidateTimesByClosures`, `nextWeekdayDate` |
| `closures/loadClosureImpact.ts` | charge règles/jobs/statuts, appelle le pur | DB, `getJobExecutionStatus` |
| `closures/cancelJobForClosure.ts` | cascade 5 étapes pour un job | huddle-bot MCP, `jobRuns`, `emitEvent`, Telegram |
| `graph/nodes/pollQuestion.ts` | `buildClosureCancelMessage`, `buildClubClosedMessage(labels)` | — |
| `http/server.ts` | routes `preview` et `create` | les trois modules ci-dessus |
| `scheduler.ts` | garde-fou dans `awaitGoAndResume`, `cancelJobRun` étendu | DB |
| `apps/ui` `ClubClosureAddForm` + actions | formulaire deux temps, `callWorker` | worker |

## Gestion des erreurs

- Worker injoignable à l'aperçu ou à la confirmation : message d'erreur dans l'UI, **rien n'est inséré** (l'insertion se fait côté worker).
- `delete_message` en échec : non bloquant, message WhatsApp adapté, `pollDeleted: false` dans l'événement et le log.
- `send_message` en échec : job quand même annulé, événement `error`, entrée dans `failed`, Telegram prévenu. L'admin peut renvoyer le message à la main.
- Écriture DB en échec après envoi WhatsApp : entrée `failed` avec l'erreur ; le job reste actif et visible dans l'aperçu si on rejoue la création (la fermeture, elle, est déjà insérée — l'aperçu d'une seconde fermeture identique le montrerait). Cas jugé rare, pas de compensation automatique.

## Tests

- **`computeClosureImpact`** : journée entière ; plage couvrant une heure sur deux (→ `running`) ; plage ne couvrant aucune heure ; job annulé ignoré ; `finished-*` ignoré ; `error` → `errored` ; `not-started` → `planned` ; règle active sans job dont le prochain jour cible est couvert → `planned` avec `jobId: null` ; heures du job prioritaires sur celles de la règle.
- **Textes** : trois variantes, avec/sans libellé, plusieurs libellés dédupliqués.
- **`cancelJobForClosure`** (mocks) : ordre `delete_message` → `send_message` → `cancelJobRun` → événement → Telegram ; `pollMsgId` absent ; `delete_message` en échec non bloquant ; `send_message` en échec → job annulé + `failed`.
- **Garde-fou** : « go » reçu après annulation → `graph.invoke` jamais appelé, log Telegram émis.
- **Routes** : `400` libellé vide / bornes invalides ; `preview` sans écriture ; `create` renvoie `cancelled` / `failed` / `planned`.
- **SendPoll** : cas A utilise le nouveau message avec libellé.
- **UI** : composant deux temps — aperçu vide, aperçu avec jobs en cours, annulation qui conserve la saisie, confirmation.

## Spécification fonctionnelle

Dans `docs/spec/regles-fonctionnelles.md`, section Fermetures PUC : remplacer « une fermeture ajoutée après l'envoi du sondage ne recalcule pas le job en cours » par les règles de la section *Règles fonctionnelles* ci-dessus, avec les textes des messages. Pas d'ADR : aucun choix d'architecture nouveau (cascade bâtie sur `delete_message`, `cancelJobRun`, événements et routes internes existants).
