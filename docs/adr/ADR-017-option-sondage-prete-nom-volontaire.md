# ADR-017 – Option de sondage "prête-nom volontaire", prioritaire sur les prête-noms par défaut

**Status:** accepted
**Date:** 2026-07-26

## Contexte

Le sondage WhatsApp (`ask_poll`, huddle-bot) est un sondage **natif à choix fixes** — pas de classification par LLM (`classify-responses.ts` côté huddle-bot ne sert qu'à `ask_question`, jamais utilisé par squash-assistant). `buildPollOptions` (`pollQuestion.ts`) construit la liste d'options : une par heure candidate + `"Non"`. Le libellé exact de l'option votée est renvoyé tel quel par `get_responses` (`statut`), sans aucune transformation côté huddle-bot au-delà d'un lowercase pour "oui"/"non" historiques (voir huddle-bot ADR-011).

Besoin exprimé : distinguer, parmi les "Non", ceux qui acceptent malgré tout de prêter leur nom pour une réservation (utile quand ADR-016 doit choisir un prête-nom et que les `substituteBookers` par défaut de la règle sont épuisés ou déjà mobilisés). Ces volontaires **de la semaine** doivent être prioritaires sur les `substituteBookers` par défaut (config générale de la règle) — une offre ponctuelle et explicite prime sur une liste par défaut.

## Décision

### 1. Nouvelle option de sondage, résolue comme un statut de plus

`buildPollOptions` ajoute une 3ᵉ option (constante partagée `SUBSTITUTE_VOLUNTEER_POLL_OPTION`, ex. `"Non, mais je peux prêter mon nom"`), à la suite des heures candidates et de `"Non"`. Aucune modification requise côté huddle-bot : le libellé exact revient tel quel dans `statut` (comme n'importe quelle option d'un sondage à choix multiples).

### 2. Résolution en parallèle des heures votées, stockage séparé

`resolveVotes` résout aussi les répondants ayant ce statut exact vers un userId resa-squash (même mécanisme `lookupPlayerByPhone` que pour les heures votées), dans un nouveau tableau `volunteerSubstituteIds: string[]` — **par job, pas par heure candidate** (une offre de prête-nom n'est pas liée à un créneau précis). Propagé dans l'état LangGraph (`PipelineState.volunteerSubstituteIds`) au même titre que `confirmedPlayerIdsByTime`, produit par `collectVotes`/`triggerRecollectVotes`.

### 3. Priorité sur `substituteBookers` par défaut

`bookSlots.ts` construit la liste de prête-noms éligibles pour chaque heure candidate en concaténant **d'abord** `volunteerSubstituteIds` (filtrés par `usedTodayIds`), **puis** `rule.substituteBookers` (même filtrage) — `buildPlanGroupBookingsParams` reçoit cette liste déjà fusionnée et ordonnée, `substitutePlayerIds` reste un simple tableau ordonné côté resa-squash (aucun changement d'API nécessaire, ADR-010 déjà accepté).

### 4. Affichage étape 2

Le regroupement par statut (Pipeline.tsx, règle du 2026-07-25) gagne une catégorie dédiée "Non mais Ok pour prête-nom", positionnée avant "non" (une offre positive, même partielle, prime sur un refus sec) mais après les heures votées/"ambigu".

## Raisons

- Réutiliser le sondage natif existant (une option de plus) plutôt qu'introduire un nouveau mécanisme de collecte — cohérent avec ADR-013 (sondage à choix multiples déjà géré par le même `ask_poll`/`get_responses`).
- Séparer `volunteerSubstituteIds` de `confirmedPlayerIdsByTime` : un prête-nom volontaire n'est jamais un joueur confirmé sur un créneau, mélanger les deux fausserait l'objectif `slotsPerPlayer`/les quotas.
- Priorité volontaires > config par défaut : une personne qui vient de se manifester explicitement cette semaine est un signal plus fort/plus fiable qu'une liste statique.

## Conséquences

- `pollQuestion.ts` : nouvelle constante exportée `SUBSTITUTE_VOLUNTEER_POLL_OPTION`, `buildPollOptions` l'ajoute.
- `resolveVotes.ts` : nouveau champ `volunteerSubstituteIds` sur `ResolvedVotes`.
- `state.ts` : nouveau champ `PipelineState.volunteerSubstituteIds: Annotation<string[]>`.
- `collectVotes.ts` / `scheduler.ts` (`triggerRecollectVotes`) : propagent ce champ comme `confirmedPlayerIdsByTime`.
- `buildBookingParams.ts` : la liste de prête-noms éligibles passée en paramètre fusionne désormais volontaires (priorité) + `rule.substituteBookers`, toujours filtrée par `usedTodayIds`/confirmés de l'heure.
- `bookSlots.ts` : construit cette liste fusionnée avant chaque appel, au lieu de ne lire que `rule.substituteBookers`.
- `Pipeline.tsx` (étape 2) : nouvelle catégorie d'affichage.
- `docs/spec/regles-fonctionnelles.md` : documente la nouvelle option et sa priorité.
- Aucun changement côté huddle-bot ni resa-squash.
