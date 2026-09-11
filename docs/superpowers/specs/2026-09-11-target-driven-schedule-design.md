# Planification pilotée par la date cible — Design

**Status:** Draft — en attente de revue utilisateur avant plan d'implémentation.
**Date:** 2026-09-11

## 1. Contexte et problème

Aujourd'hui une `BookingRule` est pilotée par la **date de lancement du sondage** :

- `pollCron` (`"0 10 * * 2"`) porte le jour de la semaine **et** l'heure du sondage ;
- `decisionCron` (`"30 21 * * 2"`) porte le jour et l'heure de la collecte des votes + calcul du plan ;
- `targetWeekdayOffset` (7) dit combien de jours **après** le déclenchement tombe la date de réservation.

Le cron calcule donc `targetDate = aujourd'hui + targetWeekdayOffset` (`scheduler/weekKey.ts::computeTargetDate`). Le jour visé (mardi, samedi…) n'existe nulle part explicitement : il est la conséquence du cron et de l'offset. Pour « réserver le samedi », on doit raisonner à l'envers (« sondage mardi + 4 jours »).

Objectif : **inverser la source de vérité**. La règle dit *quel jour et à quelle heure on veut jouer*, et *combien de jours avant* on lance le sondage et la décision. Les jours de déclenchement sont déduits. Les heures (sondage, décision, heures candidates de jeu) ne varient pas d'une semaine à l'autre ; seule la date change.

## 2. Portée

**Dans le périmètre**

- Nouveau modèle de règle (§3), migration DB avec conversion des règles existantes (§5).
- Dérivation des crons à partir du modèle (§4) ; création manuelle de job alignée sur le jour cible.
- UI de règle, extraction LLM de règle, description en français, fixtures et tests.
- Spec fonctionnelle + ADR.

**Hors périmètre**

- Une règle porte **un seul** jour cible (mardi + samedi = deux règles, comme aujourd'hui). Décision utilisateur 2026-09-11.
- Le flag `force` en cours d'ajout côté MCP resa-squash (`plan_group_bookings` / réservation) : **l'appel MCP reste identique**, le flag absent vaut `false`. Voir §8 pour la suite prévue.
- Le rappel J+1 (`nextDayReminderEnabled`) : ancré sur `JobRun.createdAt`, pas sur la date cible — inchangé.
- Le jitter (`cronJitterWindowMinutes`), l'idempotence des crons, les 4 étapes du pipeline LangGraph : inchangés.

## 3. Nouveau modèle de règle

Les trois champs `pollCron`, `decisionCron`, `targetWeekdayOffset` sont **supprimés** et remplacés par :

| Champ | Type | Sens | Exemple (règle mardi) |
|---|---|---|---|
| `targetWeekday` | `integer` 0–6 (0 = dimanche … 6 = samedi, convention JS/cron) | jour de la semaine visé pour la réservation — **source de vérité** | `2` |
| `pollDaysBefore` (N) | `integer` ≥ 1 | le sondage est lancé N jours avant la date cible | `7` |
| `pollTime` | `text` `"HH:MM"` | heure (Europe/Paris) du sondage | `"10:00"` |
| `decisionDaysBefore` (M) | `integer` ≥ 0 | collecte des votes + calcul du plan lancés M jours avant la date cible | `7` |
| `decisionTime` | `text` `"HH:MM"` | heure (Europe/Paris) de la décision | `"21:30"` |

`M` est indépendant de `N` (décision utilisateur 2026-09-11) : on peut par exemple sonder à J-9 et décider à J-7 pour retomber dans l'horizon de réservation glissant de resa-squash.

**Invariants** (fonction pure `validateRuleSchedule` dans `packages/db/src/ruleSchedule.ts`, appelée par `apps/ui/src/app/actions.ts` à la sauvegarde — l'UI est aujourd'hui le seul point d'écriture des règles, il n'y a pas d'endpoint HTTP d'upsert côté worker) :

1. `0 ≤ M ≤ N` — on ne décide pas avant d'avoir sondé.
2. `N ≥ 1`.
3. si `M == N` alors `decisionTime > pollTime` (même jour : la décision suit le sondage).
4. `pollTime` / `decisionTime` au format `^([01]\d|2[0-3]):[0-5]\d$`.

Le type `BookingRule` (`packages/db/src/schema.ts`) est mis à jour en conséquence ; `apps/ui/src/lib/worker.ts` (copie du type côté UI) aussi.

## 4. Scheduler : les crons deviennent dérivés

### 4.1 `packages/db/src/ruleSchedule.ts` (nouveau, pur, exporté `@squash-assistant/db/ruleSchedule`)

Placé dans `packages/db` (et non dans le worker) parce que trois consommateurs en ont besoin : le worker (crons dérivés), les actions serveur de l'UI (validation) et l'aperçu du formulaire (jour de déclenchement). Même logique que `ruleDescription.ts`, déjà partagé de cette façon.

```ts
export interface DerivedCrons { pollCron: string; decisionCron: string }

/** Jour de déclenchement = (targetWeekday − daysBefore) mod 7, toujours dans [0, 6]. */
export function triggerWeekday(targetWeekday: number, daysBefore: number): number;

/** "MM HH * * <jour>" pour le sondage et la décision. */
export function deriveCrons(rule: Pick<BookingRule, "targetWeekday" | "pollDaysBefore" | "pollTime" | "decisionDaysBefore" | "decisionTime">): DerivedCrons;
```

`cronRegistry.scheduleOne` appelle `deriveCrons(rule)` à la place de `rule.pollCron` / `rule.decisionCron`. Le log `[scheduler] planifié « id » poll=… decision=…` continue d'afficher les expressions (dérivées), pour garder le diagnostic actuel dans les logs du pod.

### 4.2 `scheduler.ts`

- `triggerCronSendPoll` : `computeTargetDate(new Date(), rule.pollDaysBefore)`.
- `triggerCronDecision` : `computeTargetDate(new Date(), rule.decisionDaysBefore)`.

`computeTargetDate` (`weekKey.ts`) ne change pas. Sondage et décision retombent par construction sur la **même** `targetDate` (les deux crons sont dérivés du même `targetWeekday`), donc `findActiveJobRunForDate(rule, targetDate)` retrouve le job créé par le sondage même quand `M ≠ N`. L'idempotence (job déjà actif → skip + log Telegram) est inchangée.

Cas limite documenté : si la règle est modifiée entre le sondage et la décision (changement de `targetWeekday` ou de `M`), la décision peut ne pas retrouver de job pour sa nouvelle `targetDate` → comportement existant « Aucun job actif pour le … — decisionCron ignoré » (log Telegram), et le job en attente reste déclenchable à la main depuis l'UI. Pas de mécanisme supplémentaire.

### 4.3 Job manuel (« Nouveau job », `http/server.ts::handleCreateJob`)

Aujourd'hui `targetDate = aujourd'hui + targetWeekdayOffset`. Demain : `targetDate = nextWeekdayDate(new Date(), rule.targetWeekday)` — **prochaine** occurrence du jour cible strictement après aujourd'hui (nouvelle fonction dans `weekKey.ts`, même calendrier Europe/Paris que `computeTargetDate`). La date reste modifiable via `handleEditJob` tant que le sondage n'est pas parti.

`apps/ui/src/lib/pipelinePreview.ts::computeTargetDate` n'a plus aucun appelant côté UI (l'aperçu de la question de sondage part de `job.targetDate`, déjà calculée par le worker) — supprimé, sans réplique. L'aperçu du formulaire de règle (« Sondage le lundi à 10:00 … ») utilise `triggerWeekday` importé de `@squash-assistant/db/ruleSchedule`.

## 5. Migration DB — `packages/db/src/migrations/0024_target_driven_schedule.sql`

Migration **avec conversion de données** (pas un simple `ADD COLUMN`), en une seule transaction :

1. `ALTER TABLE booking_rules ADD COLUMN target_weekday integer, poll_days_before integer, poll_time text, decision_days_before integer, decision_time text;`
2. Conversion SQL depuis les crons existants (format garanti à 5 champs `"MM HH * * D"` par la validation UI actuelle, `D` entier 0–6) :
   - `poll_time = lpad(split_part(poll_cron,' ',2),2,'0') || ':' || lpad(split_part(poll_cron,' ',1),2,'0')` (idem `decision_time`) ;
   - `jour_poll = split_part(poll_cron,' ',5)::int`, `jour_dec = split_part(decision_cron,' ',5)::int` ;
   - `target_weekday = (jour_poll + target_weekday_offset) % 7` ;
   - `poll_days_before = target_weekday_offset` ;
   - `decision_days_before = target_weekday_offset − ((jour_dec − jour_poll + 7) % 7)` (nombre de jours entre le sondage et la décision, dans la semaine) ; si le résultat est négatif (décision configurée *avant* le sondage dans la semaine — configuration incohérente dans l'ancien modèle, la décision visait alors une autre date cible), on retombe sur `decision_days_before = target_weekday_offset` (même jour que le sondage).
3. `ALTER COLUMN … SET NOT NULL` sur les 5 colonnes ; `DROP COLUMN poll_cron, decision_cron, target_weekday_offset`.

Cas dégénéré : les règles « désactivées » avec un cron sentinelle (`0 0 1 1 *`, jour `*`) — `split_part` renvoie `'*'`, cast impossible. La migration les traite avant la conversion : `target_weekday = 0`, `poll_days_before = 7`, `decision_days_before = 7`, heures `00:00`/`00:00`, et force `enabled = false` (elles le sont déjà). Vérifié sur les 5 règles réelles en base avant merge (`psql`).

Appliquée automatiquement par l'initContainer du worker (ADR-012) — rien à lancer manuellement en prod ; `db:migrate` seulement en dev local. Le snapshot drizzle (`meta/0024_snapshot.json`, `_journal.json`) est généré par `db:generate` puis le SQL est édité à la main pour la partie conversion.

Vérification attendue sur les règles réelles (`fixtures/realRules.ts`) :

| règle | avant | après |
|---|---|---|
| squashacademie-mardi | poll `0 10 * * 2`, dec `30 21 * * 2`, offset 7 | `targetWeekday=2`, N=7, `10:00`, M=7, `21:30` |
| squash-samedi-matin | poll `0 10 * * 2`, dec `30 21 * * 2`, offset 4 | `targetWeekday=6`, N=4, `10:00`, M=4, `21:30` |

## 6. Surface UI, LLM, description

- **`apps/ui/src/app/rules/RuleForm.tsx`** : les deux `CronField` et « Décalage jour cible » sont remplacés par un bloc « Planification » : `<select name="targetWeekday">` (lundi…dimanche), `pollDaysBefore` (number) + `pollTime` (`<input type="time">`), `decisionDaysBefore` + `decisionTime`. Aperçu textuel sous le bloc : « Sondage le lundi à 10:00, décision le lundi à 21:30, pour le mardi suivant » (calculé côté client via `triggerWeekday`, répliqué dans `pipelinePreview.ts`). `CronField.tsx` n'est plus utilisé par ce formulaire — supprimé s'il n'a plus aucun usage.
- **`apps/ui/src/app/actions.ts`** : lecture des 5 champs, validation des invariants §3 avec message d'erreur explicite.
- **`RuleGeneratorPanel.tsx`** : mapping des 5 champs à la place des 3.
- **`apps/worker/src/llm/ruleParamsExtraction.ts`** : le JSON schema expose `targetWeekday` (0–6), `pollDaysBefore`, `pollTime`, `decisionDaysBefore`, `decisionTime` avec descriptions ; les crons disparaissent du prompt. `ruleParamsExtraction.integration.test.ts` et `ruleDescription.test.ts` continuent d'utiliser `REAL_RULES` (mises à jour §5).
- **`packages/db/src/ruleDescription.ts`** : « La réservation vise chaque mardi (heures candidates : 18H45, 19H30). Le sondage WhatsApp est envoyé 7 jours avant, le lundi à 10:00 ; la collecte des votes et le calcul du plan 7 jours avant, le lundi à 21:30. » `describeCron` n'a plus d'usage → supprimé.
- **`apps/worker/src/scripts/test-graph.ts`**, **`packages/db/src/fixtures/realRules.ts`** : champs mis à jour.

## 7. Documentation

- `docs/spec/regles-fonctionnelles.md` : nouvelle règle « Planification pilotée par la date cible (2026-09-11) » décrivant les 5 champs, les invariants, la dérivation des jours, le job manuel = prochaine occurrence ; ligne de changelog. Les mentions existantes de `pollCron` / `decisionCron` (jitter, idempotence) sont reformulées en « déclenchement sondage » / « déclenchement décision ».
- `docs/adr/ADR-030-planification-pilotee-par-date-cible.md` + ligne dans `docs/adr/README.md`.
- `docs/plan/squash-assistant-poc.md` : point ouvert « flag `force` resa-squash » ajouté (§8).

## 8. Suite prévue (non implémentée ici) : flag `force` resa-squash

resa-squash impose un horizon de réservation glissant de 7 jours (ADR-012 côté resa-squash). Un flag `force` est en cours d'ajout côté MCP : `true` = réserver quand même, sans créer de « planification » si la date cible est trop loin.

Rappel : **M = `decisionDaysBefore`**, le nombre de jours avant la date cible auquel se déclenche la décision — collecte des votes, calcul du plan, attente du « go », puis appel à resa-squash (`plan_group_bookings` / réservation). Au moment où squash-assistant demande la réservation, la date cible est donc exactement à M jours. Avec le nouveau modèle, « est-on trop loin de la date cible ? » se lit directement sur M :

- `M ≤ 7` : dans l'horizon, comportement actuel, `force` inutile.
- `M > 7` (ex. décider 9 jours avant le match) : hors horizon → il faudra passer `force: true`, sinon resa-squash crée une planification au lieu d'une réservation.

Options à trancher dans une itération dédiée : dériver `force = decisionDaysBefore > 7` automatiquement, ou exposer `BookingRule.forceBooking`. **Dans cette itération, l'appel MCP ne change pas** (flag absent = `false`).

## 9. Tests

- `scheduler/ruleSchedule.test.ts` : `triggerWeekday` (wrap-around : samedi − 7 = samedi, mardi − 4 = vendredi, dimanche − 1 = samedi), `deriveCrons` (N ≠ M, M = 0, heures avec zéro initial).
- `scheduler/weekKey.test.ts` : `nextWeekdayDate` (aujourd'hui = jour cible → +7 ; fuseau Paris).
- `scheduler/cronRegistry.test.ts` / `scheduler.test.ts` : fixtures adaptées, vérification que les crons enregistrés sont les crons dérivés.
- `packages/db/src/ruleDescription.test.ts`, `llm/ruleParamsExtraction.integration.test.ts` : sur `REAL_RULES` convertis.
- Validation des invariants (`actions.ts` ou fonction pure partagée `validateRuleSchedule` dans `packages/db`) : cas M > N, M = N avec heures inversées, formats d'heure invalides.
- Migration : exécutée en local (docker-compose) sur un dump des règles réelles, résultat comparé au tableau §5.
- Tests existants du pipeline (`bookSlots`, `announce`, `sendPoll`, `planJob`, `scenarios.regression`, `simulateScenario`) : seules les fixtures de règle changent.
