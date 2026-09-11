# ADR-031 – Réservation toujours forcée (`force: true`) : squash-assistant décide seul du « quand »

**Status:** accepted
**Date:** 2026-09-11

## Contexte

resa-squash a introduit les **réservations planifiées** (resa-squash ADR-013, 2026-09-11) : pour un
appelant `ADMIN` / `POWER_USER`, une demande de réservation au-delà de `J + lead_days` (réglage du
club, de l'ordre de 5 jours) ne pose plus la réservation sur TeamR mais crée une *planification*,
exécutée plus tard à l'heure H du club. Un passe-droit `force: true` permet de réserver en direct
quand même ; absent, il vaut `false`. Le paramètre est exposé sur les API web et agent, et sur le MCP
`reserve_slot` depuis la phase 5 de resa-squash (commit `ae87059`, déployée en prod Vercel le
2026-09-11) : réponse `{ reservation, forced }`, nouvelles raisons d'erreur
`SCHEDULING_NOT_ALLOWED`, `SCHEDULING_DELAY_TOO_LONG`, `SCHEDULED_SLOT_CONFLICT`,
`NO_TEAMR_TOKEN_FOR_USER`.

Or squash-assistant porte **sa propre** logique de calendrier ([ADR-030](./ADR-030-planification-pilotee-par-date-cible.md)) :
le sondage part N jours avant la date cible, la décision — collecte, plan, « go » Telegram, puis
réservation — M jours avant. Avec les règles réelles (M = 7) la réservation est demandée hors de
`J + lead_days` : sans `force`, resa-squash la transformerait en planification, exécutée à une
heure choisie par le club et non par la règle, et l'étape Announce annoncerait des créneaux non
encore posés.

## Décision

1. **squash-assistant réserve toujours en direct** : le wrapper `reserveSlot`
   (`apps/worker/src/mcp/resaSquash.ts`) envoie systématiquement `force: true` à `reserve_slot`.
   C'est lui qui a la connaissance métier du moment où réserver (règle, votes, « go ») ; il ne
   délègue jamais le différé à resa-squash.
2. **Pas de paramètre de règle** (`forceBooking`), **pas de dérivation** depuis M : le flag n'est pas
   une option produit mais une propriété de l'intégration. La seule décision qui reste côté
   produit est M (ADR-030).
3. Le passe-droit est effectif de bout en bout depuis le 2026-09-11 (squash-assistant `94ccdff`
   sur K3s, resa-squash phase 5 sur Vercel). Le champ `forced` de la réponse n'est pas lu :
   squash-assistant ne consomme que `reservation`.

## Conséquences

- La cascade prête-noms / joker (ADR-028) passe par le même wrapper : toutes les tentatives sont
  forcées, y compris les substitutions.
- `force` est tracé côté resa-squash (`forced = true` dans `BookingMetaHint`) : les réservations
  posées par squash-assistant seront identifiables comme forcées — c'est voulu.
- La clé API de squash-assistant doit rester `ADMIN` / `POWER_USER` côté resa-squash : un membre
  ordinaire envoyant `force: true` reçoit le 403 `BOOKING_HORIZON_EXCEEDED` (ADR-012 resa-squash),
  sans planification de repli.
- Les nouvelles raisons d'erreur resa-squash (`SCHEDULING_NOT_ALLOWED` si la clé API perdait son
  rôle étendu, `NO_TEAMR_TOKEN_FOR_USER`) ne sont **pas** interprétées par la cascade
  prête-noms / joker (ADR-028) : elles remontent comme refus « autre » dans l'annonce partielle
  (ADR-027) et sur Telegram — visibles, pas contournées. À réévaluer si l'une d'elles survient.
- Le point ouvert « flag `force` » du plan POC est fermé ; la « suite prévue » d'ADR-030 est
  remplacée par cette décision.
