# Design — Rappel WhatsApp avant le match

**Date** : 2026-10-05  
**Statut** : validated (brainstorming) — en attente de relecture de la spec écrite  
**Approche** : tick global chaque minute dans le worker, qui envoie un rappel par job annoncé, X minutes avant le premier créneau réservé  
**Complète** : [ADR-033](../../adr/ADR-033-confirmation-whatsapp-jour-cible.md), [ADR-035](../../adr/ADR-035-destinataire-confirmation-distinct-annonce.md)  
**ADR à créer** : ADR-036 — rappel déclenché par un tick global plutôt que par un cron par règle

## Problème

La confirmation WhatsApp (étape 5) part le **jour de la décision**, à `confirmationTime` ±10 min (ADR-033, révision du 2026-10-01). Pour la squashacadémie comme pour le samedi matin, plusieurs jours peuvent séparer ce message du match (jusqu'à 5). Les joueurs oublient le terrain, l'heure, avec qui ils jouent, et n'ont plus les QR sous la main.

Aucun code existant n'envoie de message calé sur l'heure des créneaux : tous les crons (sondage, décision, confirmation) sont dérivés de jours et d'heures fixes de la règle (`deriveCrons`).

## Objectifs

1. Le jour du match, envoyer **un seul rappel par job**, **X minutes avant le premier créneau réellement réservé** (X réglable par règle, défaut 120), dans une fenêtre de ±10 min.
2. Même contenu que la confirmation : date, courts et créneaux fusionnés, joueurs ayant répondu oui, QR en réservation réelle.
3. Même destinataire que la confirmation (`resolveConfirmationNotifyJid`).
4. Robuste aux redémarrages du pod et aux déploiements progressifs : jamais de double envoi, rattrapage tant que le créneau n'a pas commencé.

## Hors périmètre

- Un rappel par heure de début (décision Q1 : un seul rappel, 2 h avant le premier créneau, qui récapitule tout le job).
- Un champ « groupe du rappel » dédié (décision Q2 : groupe de la confirmation).
- Stocker le décalage tiré au hasard (il est dérivé de l'id du job).
- Toute modification du comportement de la confirmation (étape 5), hors l'ajout d'un `variant` au constructeur de message.
- Relevé en relecture, **non traité ici** : `ruleDescription.ts` annonce la confirmation même quand `nextDayReminderEnabled` est faux.

## Décisions validées

| # | Question | Décision |
|---|----------|----------|
| Q1 | Plusieurs heures de début dans le job | Un seul rappel, avant le **premier** créneau réservé |
| Q2 | Destinataire | Groupe de la confirmation (`confirmationNotifyWhatsappGroupJid`, sinon groupe du sondage) |
| Q3 | Délai | Réglable par règle, en minutes, défaut 120, bornes 30–360 |
| D1 | Décision le jour du match (`decisionDaysBefore = 0`) | Pas de rappel ; expliqué dans l'aide du formulaire |
| D2 | Dry-run | Envoyé seulement si le destinataire **n'est pas** le groupe du sondage ; titre « dry-run — aucun court réservé », sans QR |
| D3 | Fenêtre ±10 min | Conservée ; décalage dérivé d'un hash de l'id du job, tick chaque minute |

## Comportement

### Réglages par règle

- `startReminderEnabled` — booléen, défaut `false` (opt-in, aucun changement au déploiement).
- `startReminderMinutesBefore` — entier, défaut `120`, bornes **30–360**.

### Heure d'envoi

Tous les calculs se font en **minutes depuis minuit, heure murale de Paris**, le jour de la date cible :

```
premierCréneau = min(parseTeamrTime(b.slotTime)) sur reservedBookings(bookingPlanGroups, reservationFailures), null ignorés
décalage       = hash(jobId) → entier dans [−10, +10) minutes   (FNV-1a 32 bits, déterministe)
heureEnvoi     = premierCréneau − startReminderMinutesBefore + décalage
maintenant     = heure:minute de now dans Europe/Paris (Intl.DateTimeFormat, timeZone "Europe/Paris")
```

- On ne construit **aucune** `Date` Paris à partir d'une date et d'une heure : l'heuristique existante `slotStartDateIsoHeuristicParis` (`apps/worker/src/planning/teamrTime.ts`, « +02:00 d'avril à octobre ») est fausse après le passage à l'heure d'hiver (fin octobre) et décalerait le rappel d'une heure. Elle est **interdite** ici. La condition « date du jour = `targetDate` » (calculée par `computeTargetDate(now, 0)`) rend la comparaison en minutes suffisante.
- `slotTime` est au format TeamR (`"18H45"`) : lecture **obligatoire** via `parseTeamrTime` (`apps/worker/src/graph/capacityPlanning.ts`, renvoie des minutes ou `null`), jamais un tri de chaînes.
- `reservedBookings` exclut les créneaux hors fenêtre (ADR-014) et ceux refusés à la réservation réelle (ADR-027).
- Le décalage est stable d'un tick à l'autre et après un redémarrage ; il change d'une semaine à l'autre puisque l'id du job change.

### Conditions d'envoi (évaluées à chaque tick)

Le rappel part au premier tick où **toutes** les conditions sont vraies :

1. Règle **live** : `enabled`, `startReminderEnabled`, `decisionDaysBefore > 0`.
2. Job = celui de `findActiveJobRunForDate(db, rule.id, computeTargetDate(now, 0))` — un seul job par date, comme la confirmation. Attention : cette fonction retient le job non annulé **le plus récent**, pas forcément le job automatique ; les autres jobs de la même date sont ignorés.
3. Job non annulé (`cancelledAt` nul) et `startReminderSentAt` nul.
4. Stage `finished-announced` (via `getJobExecutionStatus`).
5. Au moins un créneau dans `reservedBookings`.
6. Dry-run (`dryRun !== false`) : destinataire différent de `rule.whatsappGroupJid`.
7. `heureEnvoi ≤ maintenant < premierCréneau`.

Logs Telegram de saut — **un seul par job**, mémorisé dans un `Set` en mémoire partagé avec le log d'erreur d'envoi (perdu au redémarrage : au pire un log de plus, acceptable) :

- **Job non annoncé** : au **premier tick de la date cible** où les conditions 1–3 sont vraies et le stage ≠ `finished-announced`, **seulement si le job est resté bloqué** (`not-started`, `awaiting-decision`, `awaiting-plan`, `awaiting-go`, `error`). Un job terminé sans annonce (`finished-no-plan`, `finished-cancelled`, `finished-club-closed`) est normal : pas de log. Avec `decisionDaysBefore ≥ 1`, un job non annoncé le jour du match ne le sera plus : inutile d'attendre une heure d'envoi (qu'on ne peut pas calculer sans plan).
- Les autres sauts (option désactivée, décision le jour même, aucun créneau, dry-run vers le groupe du sondage) sont silencieux côté Telegram et visibles dans l'UI (motif calculé).

### Envoi, idempotence et reprise

Ordre strict :

1. **Réservation atomique** du job, en Drizzle comme `markNextDayReminderSent` (`jobRuns.ts`) :
   `db.update(jobRuns).set({ startReminderSentAt: new Date() }).where(and(eq(jobRuns.id, jobId), isNull(jobRuns.startReminderSentAt))).returning({ id: jobRuns.id })`.
   Aucune ligne retournée → un autre tick ou un autre pod s'en charge : on s'arrête.
2. `sendMessage` (huddle-bot) vers le destinataire.
   - Échec → `start_reminder_sent_at` remis à `NULL`, un **seul** log Telegram d'erreur par job, nouvel essai au tick suivant tant que le premier créneau n'a pas commencé.
3. En réservation réelle : `sendBookingQrCodes` — QR redemandés à resa-squash (ADR-026). Cette fonction ne lève jamais d'erreur : un échec QR ne provoque jamais de renvoi du message.
4. Log Telegram : `[<ruleId>] Rappel avant match envoyé pour le <date> (WhatsApp <jid>).`

Garantie : **au plus un message par job**, y compris pendant un déploiement progressif où deux pods coexistent brièvement, avec reprise sur échec d'envoi. Deux limites assumées :

- `sendMessage` en timeout alors que huddle-bot a bien envoyé → la remise à `NULL` provoque un second envoi (doublon possible, rare).
- Pod tué entre la réservation et l'envoi → job marqué envoyé sans message (rappel perdu, rare).

### Règle live ou règle figée

- **Règle live** (relue à chaque tick) : `enabled`, `startReminderEnabled`, `startReminderMinutesBefore`, `decisionDaysBefore`, destinataire — réglages opérationnels, comme le destinataire de la confirmation (ADR-035) et le joker (ADR-024).
- **Règle figée** (`status.values.bookingRule`, snapshot pris au sondage ; repli sur `job.ruleSnapshot` s'il est absent) : contenu du message. Sinon un `candidateStartTimes` modifié depuis ferait perdre des lignes « Oui au sondage ». Écart assumé avec la confirmation actuelle, qui passe la règle live — à noter dans l'ADR-036.

### Message

`buildBookingConfirmationMessage` reçoit un dernier paramètre `variant: "confirmation" | "start-reminder" = "confirmation"` :

| variant | réel | dry-run |
|---------|------|---------|
| `confirmation` | `✅ Confirmation — Réservation pour <jour>` (inchangé) | `✅ Confirmation — Réservation (dry-run) pour <jour>` (inchangé) |
| `start-reminder` | `⏰ Rappel — Squash aujourd'hui (<jour>)` | `⏰ Rappel (dry-run — aucun court réservé) — <jour>` |

Corps identique : date, courts fusionnés (`formatMergedCourtSlots`), bloc « Oui au sondage ». Les appelants existants (`scheduler.ts`, `announce.test.ts`) restent valides grâce à la valeur par défaut. `variant` vient après `reservationFailures = []` : le rappel passe `reservationFailures` explicitement.

### Interactions

- **Fermeture du club** : la cascade (`closureImpact.ts`, `RUNNING_STAGES`) n'annule que les jobs en cours. Un job déjà `finished-announced` garde son rappel — cohérent, ses réservations TeamR existent toujours.
- **Confirmation (étape 5)** : indépendante. Avec `decisionDaysBefore ≥ 1`, confirmation et rappel ne tombent jamais le même jour.
- **Règle désactivée ou option décochée** après l'annonce : le rappel ne part pas (règle live).

## Données

Migration `0032` générée par `(cd packages/db && npm run db:generate -- --name start_reminder)` (SQL + snapshot meta + journal), appliquée par l'initContainer (ADR-012) :

```sql
ALTER TABLE booking_rules ADD COLUMN start_reminder_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE booking_rules ADD COLUMN start_reminder_minutes_before integer NOT NULL DEFAULT 120;
ALTER TABLE job_runs      ADD COLUMN start_reminder_sent_at timestamp;
```

`timestamp` sans fuseau, comme toutes les colonnes de `job_runs` (dont `next_day_reminder_sent_at`) ; valeur écrite par Drizzle (`new Date()`), jamais par `now()` SQL.

- `BookingRule` est une interface écrite à la main (`packages/db/src/schema.ts`) : y ajouter les deux champs, puis dans **tous** les objets `BookingRule` complets (même liste que lors de l'ajout de `pinMessagesEnabled`, commit `42ec4af`) : `packages/db/src/fixtures/realRules.ts`, `closureImpact.test.ts`, `cronRegistry.test.ts`, `scheduler.test.ts`, `planJob.test.ts`, `simulateScenario.test.ts`, `scenarios.regression.test.ts`, `bookSlots.test.ts`, `announce.test.ts`, `sendPoll.test.ts`, `scripts/test-graph.ts`, valeurs par défaut de `RuleGeneratorPanel.tsx`.
- `JobRun` (`$inferSelect`) : `startReminderSentAt: null` dans les fixtures `closureImpact.test.ts` et `scheduler.test.ts`.
- **Seed** : ne **pas** ajouter les champs à `packages/db/seeds/booking-rules.seed.json` — `seed.ts` fait `set: rule` avec les seules clés du JSON, donc un `db:seed` ne les écrase jamais.
- Pas d'impact : `ExtractableRuleParams` (pas de cases à cocher), zod (aucun), `booking_rule_history` (supprimée en 0014).

## Worker

| Fichier | Changement |
|---------|------------|
| `apps/worker/src/scheduler/startReminder.ts` (nouveau) | Fonctions pures : `parisMinutesNow(now)`, `firstReservedSlotMinutes`, `startReminderOffsetMinutes(jobId)` (FNV-1a), `plannedStartReminderMinutes`, `evaluateStartReminder(...)` → `{ state, plannedAt?: "16h45", reason? }` (états et priorité : voir ci-dessous) |
| `apps/worker/src/scheduler/scheduler.ts` | `triggerStartReminders(now)` : filtre DB → `getJobExecutionStatus` sur le reste → `evaluateStartReminder` → réservation atomique → envoi → QR → log. Branché dans `scheduleBookingRules` via `onStartReminderTick`. |
| `apps/worker/src/scheduler/cronRegistry.ts` | `SchedulerRuntime.onStartReminderTick: (now: Date) => Promise<void>`. Tick `* * * * *` (Europe/Paris) créé **une fois** dans `startCronRegistry` (arrêt de l'ancien tick avant d'en créer un), conservé par `reloadScheduler`, arrêté dans `__resetCronRegistryForTests`. Erreurs attrapées et loguées. |
| `apps/worker/src/jobRuns.ts` | `claimStartReminder(db, jobId)` (UPDATE … RETURNING), `releaseStartReminder(db, jobId)`. |
| `apps/worker/src/graph/nodes/announce.ts` | Paramètre `variant` de `buildBookingConfirmationMessage`. |
| `apps/worker/src/http/server.ts` | `handleJobStatus` (`GET /rules/:id/jobs/:jobId/status`) ajoute `startReminder: { state, plannedAt?, reason? }` à sa réponse, calculé par `evaluateStartReminder` (avec `findActiveJobRunForDate` pour savoir si le job est l'actif de sa date) — l'UI ne duplique aucune logique (décalage, `parseTeamrTime`, `reservedBookings`). |

Coût du tick : 1 + N requêtes DB par minute (N = règles éligibles, 0 à 2) ; `getJobExecutionStatus` (Redis) seulement pour les jobs du jour retenus.

### États du rappel et priorité

`evaluateStartReminder` retourne le **premier** état applicable dans cet ordre :

| # | Condition | État | Motif affiché |
|---|-----------|------|---------------|
| 1 | `startReminderSentAt` renseigné | `sent` | — |
| 2 | règle (live) désactivée ou `startReminderEnabled` faux | `disabled` | Non activé pour cette règle |
| 3 | `job.createdAt` < date de déploiement de la migration `0032` | `disabled` | — (job antérieur à la fonctionnalité) |
| 4 | `decisionDaysBefore = 0` | `skipped` | décision le jour du match |
| 5 | job annulé | `skipped` | job annulé |
| 6 | job ≠ job actif de sa date | `skipped` | pas le job actif de cette date |
| 7a | stage ≠ `finished-announced` et `targetDate` > aujourd'hui | `waiting` | En attente de l'annonce (étape 4) |
| 7b | stage ≠ `finished-announced` (jour du match ou après) | `skipped` | job non annoncé |
| 8 | aucun créneau réservé | `skipped` | aucun créneau réservé |
| 9 | dry-run vers le groupe du sondage | `skipped` | dry-run vers le groupe d'origine |
| 10 | `targetDate` < aujourd'hui, ou aujourd'hui et `maintenant ≥ premierCréneau` | `missed` | Non envoyé (créneau commencé) |
| 11 | `targetDate` > aujourd'hui, ou aujourd'hui et `maintenant < heureEnvoi` | `waiting` | Prévu vers HHhMM (±10 min) |
| 12 | sinon | `due` | Envoi imminent |

Ligne 3 : la date de déploiement n'existe pas en base ; elle est figée dans une constante `START_REMINDER_SINCE` (date de mise en production, renseignée dans le commit de release). Sans elle, tous les jobs passés afficheraient `missed`.

## UI

- **`RuleForm.tsx`**, sous la case « Confirmation WhatsApp » :
  - case « Rappel avant le match » (`startReminderEnabled`) ;
  - champ « minutes avant le premier créneau » (`startReminderMinutesBefore`, `type="number"`, `min=30`, `max=360`, défaut 120) ;
  - aide : « Envoyé dans le groupe de confirmation, X min (±10) avant le premier créneau réservé. Inactif si la décision a lieu le jour du match. »
- **`actions.ts`** : lecture des deux champs ; bornes 30–360 vérifiées avec un message d'erreur explicite, pas de correction silencieuse (contrairement à `cronJitterWindowMinutes`, borné par `Math.min/Math.max`).
- **`apps/ui/src/lib/worker.ts`** : `JobWithStatus` reçoit `startReminder: StartReminderInfo`.
- **`packages/db/src/ruleDescription.ts`** : phrase « rappel N h/min avant le premier créneau (±10 min) » **uniquement** si `startReminderEnabled`.
- **Page du job** (`page.tsx` + `Pipeline.tsx`) : étape 6 « Rappel avant le match », type `StartReminderInfo` (`ReminderInfo` désigne déjà l'étape 5), alimentée par `startReminder` de la réponse status et par `startReminderSentAt` (ajouté au select DB existant de `page.tsx`, pour la date d'envoi). Libellés : colonne « Motif affiché » du tableau des états ; `sent` → « ✓ Envoyé le … ».
- Aperçu du bloc Planification (`ScheduleFields.tsx`) : inchangé — l'heure dépend des créneaux réservés, inconnue à l'édition.

## Tests

**Purs (`startReminder.test.ts`)**
- `parseTeamrTime` sur `"9H00"`, `"18H45"` ; premier créneau parmi plusieurs groupes ; créneaux refusés / hors fenêtre ignorés.
- Décalage : même id → même valeur ; toujours dans `[−10, +10)`.
- `evaluateStartReminder` : chaque ligne du tableau des états, et la priorité (ex. job annulé ET non annoncé → « job annulé » ; job antérieur à `START_REMINDER_SINCE` → `disabled`, jamais `missed`).
- `parisMinutesNow` : un instant de fin octobre après le passage à l'heure d'hiver (ex. 2026-10-27T15:45Z → 16h45) et un instant d'été.

**Scheduler (`scheduler.test.ts`, dépendances simulées)**
- Nominal réel : message `start-reminder`, puis QR, puis log ; `startReminderSentAt` posé.
- Deux ticks concurrents → un seul `sendMessage`.
- `sendMessage` en échec → colonne remise à `NULL`, un seul log d'erreur sur deux ticks, envoi au tick suivant.
- Job non annoncé le jour cible → un seul log Telegram sur plusieurs ticks.
- Dry-run vers le groupe du sondage → aucun envoi ; vers un groupe de test → envoi sans QR.
- Plusieurs jobs pour la date → seul le job actif est traité.
- Délai modifié sur la règle live après le lancement du job → délai live utilisé ; contenu du message tiré du snapshot.

**Registry (`cronRegistry.test.ts`)** : le test « 3 crons » devient « 3 crons par règle + 1 tick global » ; tick unique après plusieurs `startCronRegistry` / `reloadScheduler` ; arrêté au reset. `onStartReminderTick` étant requis dans `SchedulerRuntime`, tous les appels existants de `startCronRegistry` dans ce fichier le fournissent (mock).

**Non-régression** : `buildBookingConfirmationMessage` sans `variant` produit exactement les titres actuels.

**UI** : lecture du formulaire (bornes, erreur) ; texte de `ruleDescription` avec et sans rappel.

## Documentation

- `docs/spec/regles-fonctionnelles.md` : section « Rappel avant le match » (réglages, heure d'envoi, conditions, dry-run, destinataire, étape 6).
- `docs/adr/ADR-036-rappel-avant-match-tick-global.md` : choix du tick global (vs `setTimeout` à l'annonce, vs cron par règle), réservation atomique avant envoi, décalage par hash, règle live vs figée.
- `docs/adr/README.md` : index.

## Critère de succès

Pour un mardi de la squashacadémie (premier créneau 18H45, délai 120), en réservation réelle, en heure d'été comme en heure d'hiver : un seul message « ⏰ Rappel » avec les QR arrive dans le groupe de confirmation entre 16h35 et 16h55, l'étape 6 du job passe à « ✓ Envoyé », un log Telegram le confirme — y compris si le pod a redémarré entre l'annonce et 16h35.
