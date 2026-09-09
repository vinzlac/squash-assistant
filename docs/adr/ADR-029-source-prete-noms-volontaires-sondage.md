# ADR-029 – Source des prête-noms : les volontaires du sondage, `substituteBookers` laissé dormant

**Status:** accepted
**Date:** 2026-09-09

## Contexte

En sortant de l'incident du 2026-09-08 ([ADR-027](./ADR-027-reservation-partielle-sans-rollback.md),
[ADR-028](./ADR-028-cascade-prete-noms-joker-a-la-reservation.md)), la cascade de remplacement à
la réservation réelle consomme deux sources de prête-noms, dans cet ordre :

1. `volunteerSubstituteIds` — les joueurs ayant répondu « Non, mais je peux prêter mon nom » au
   sondage de la semaine ([ADR-017](./ADR-017-option-sondage-prete-nom-volontaire.md)) ;
2. `BookingRule.substituteBookers` — une liste fixe, configurée par règle
   ([ADR-016](./ADR-016-prete-noms-substitution-quota-titulaire.md)).

La recommandation faite à l'issue d'ADR-028 — « configurer un ou deux prête-noms sur la règle du
mardi pour que la cascade serve à quelque chose » — a été explicitement écartée : **prêter son
nom est un engagement ponctuel, que le joueur renouvelle chaque semaine en répondant au sondage,
pas un statut acquis une fois pour toutes.** Réserver au nom de quelqu'un qui ne s'est pas
manifesté cette semaine-là n'est pas acceptable, même s'il a accepté les semaines précédentes.

Constat en base au moment de la décision : les **cinq** `booking_rules` ont
`substitute_bookers = []`. Le champ est donc déjà inutilisé en production — mais toujours exposé
dans le formulaire de règle, donc remplissable par erreur (ce que la recommandation ci-dessus
allait provoquer).

## Décision

1. **Source unique des prête-noms : les volontaires explicites du sondage.** Un prête-nom doit
   s'être manifesté pour la semaine en cours.
2. **Le joker (`jokerBookerId`) est le seul cas particulier** : prête-nom global et permanent,
   toujours d'accord, mobilisé en **dernier recours** après les volontaires (ADR-024, ADR-028).
   C'est une exception assumée, justifiée par son rôle (gérant du club) et par le fait qu'elle
   ne repose pas sur la disponibilité d'un joueur.
3. **`substituteBookers` est conservé mais dormant** : il doit rester vide sur toutes les règles.
   Le champ reste dans la base, le formulaire, le moteur de plan et la cascade de réservation,
   sans être alimenté. La règle est écrite dans `docs/spec/regles-fonctionnelles.md` §6, seule
   référence opposable.

### Options envisagées pour `substituteBookers`

| Option | Portée | Retenue |
|---|---|---|
| Le retirer partout | Formulaire UI, `planJob`, `buildGroupBookingPlanParams`, `sessionExtension`, cascade de réservation, extraction LLM, simulateur, + migration Drizzle de la colonne | non |
| Le masquer dans le formulaire | UI seule, code de repli inerte | non |
| **Le documenter et le laisser dormant** | Spec uniquement, zéro code | **oui** |

Motif du choix : le champ est déjà vide partout, donc le supprimer ne change **aucun**
comportement observable, tout en touchant le moteur de plan, le simulateur et une colonne en
base — beaucoup de risque pour zéro gain fonctionnel. La règle écrite suffit à empêcher qu'on le
remplisse, et le champ garde sa valeur d'échappatoire manuelle si un cas exceptionnel se présente.

## Conséquences

- **ADR-016 devient dormante en pratique** : son mécanisme reste implémenté, sa source
  d'alimentation est tarie par convention.
- **ADR-017 devient la source unique** des prête-noms, et non plus seulement la source
  prioritaire.
- **Sans volontaire une semaine donnée, la cascade se réduit au joker.** S'il est lui-même refusé
  par TeamR (crédits épuisés), la ligne est perdue et les autres réservations du lot sont
  conservées (ADR-027). C'était exactement le cas du job `fcd8c206` : zéro volontaire, joker à
  sec — ADR-028 n'y aurait donc rien changé.
- **La marge joueurs imprévus** (`unexpectedPlayersMargin`, à 1 sur la règle du samedi) puise
  dans le même pool : elle dépend elle aussi des volontaires du sondage.
- **Risque accepté** : le champ reste visible dans le formulaire de règle. Si quelqu'un le
  remplit un jour, le comportement redeviendra celui d'ADR-016 sans avertissement. C'est le prix
  de l'option retenue ; la spec est le garde-fou.
