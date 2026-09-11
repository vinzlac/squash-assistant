# ADR-030 – Planification pilotée par la date cible : le jour de réservation fait foi, les crons sont dérivés

**Status:** accepted
**Date:** 2026-09-11

## Contexte

Jusqu'ici une `BookingRule` était pilotée par la date de lancement du sondage : `pollCron` et
`decisionCron` portaient le jour et l'heure des déclenchements, et `targetWeekdayOffset` disait
combien de jours *après* tombait la réservation. Le jour visé (mardi, samedi…) n'existait nulle
part explicitement — pour « réserver le samedi », il fallait raisonner à l'envers (« sondage mardi
+ 4 jours »). Le besoin exprimé le 2026-09-11 : la source de vérité doit être la date et l'heure
de réservation voulues ; le sondage et la décision sont « N / M jours avant ».

Côté resa-squash, un flag `force` est en cours d'ajout (réserver hors de l'horizon glissant de
7 jours, [resa-squash ADR-012], sans créer de planification). Il n'est pas consommé ici.

## Décision

1. **Nouveau modèle de règle** : `targetWeekday` (0 = dimanche … 6 = samedi), `pollDaysBefore`
   (N ≥ 1) + `pollTime`, `decisionDaysBefore` (M, 0 ≤ M ≤ N, indépendant de N) + `decisionTime`.
   Si M = N, `decisionTime > pollTime`. Une règle = un seul jour cible.
2. **Crons dérivés, jamais stockés** : `packages/db/src/ruleSchedule.ts::deriveCrons` calcule
   `"MM HH * * ((targetWeekday − N) mod 7)"` ; `cronRegistry` l'appelle à chaque (re)planification.
   `computeTargetDate(now, N | M)` est inchangé — sondage et décision retombent sur la même
   `targetDate`, donc sur le même job, même quand N ≠ M.
3. **Job manuel** : `targetDate` = prochaine occurrence du jour cible strictement après
   aujourd'hui (`weekKey.ts::nextWeekdayDate`).
4. **Migration 0024 avec conversion SQL** des règles existantes (`target_weekday = (jour_poll +
   offset) % 7`, `poll_days_before = offset`, `decision_days_before = offset − ((jour_dec −
   jour_poll + 7) % 7)`), puis suppression des trois anciennes colonnes. Sentinelles
   `0 0 1 1 *` → valeurs neutres, règle désactivée.
5. **Validation** partagée (`validateRuleSchedule`) appelée par l'action serveur de l'UI, seul
   point d'écriture des règles.

## Conséquences

- L'UI, l'extraction LLM (`ruleParamsExtraction`) et la description en français
  (`describeRuleInFrench`) parlent en « jour cible + jours avant + heures », plus en crons ;
  `CronField.tsx` est supprimé.
- Le rappel J+1 (`nextDayReminderEnabled`) reste ancré sur `JobRun.createdAt`, pas sur la cible.
- Le jitter et l'idempotence des déclenchements auto ne changent pas.
- Les règles héritées dont l'ancien modèle avait la décision le même jour que le sondage mais à
  une heure antérieure (M = N, `decisionTime ≤ pollTime`) sont migrées telles quelles ;
  l'invariant n'est appliqué qu'à la prochaine sauvegarde depuis l'UI.
- **Flag `force`** : tranché par [ADR-031](./ADR-031-reservation-toujours-forcee.md) — `reserve_slot` est toujours appelé avec `force: true`, quel que soit M.
