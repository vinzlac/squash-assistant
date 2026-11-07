# ADR-039 – Plan créneau par créneau : tous les inscrits jouent, 2 joueurs par court

**Status:** accepted
**Date:** 2026-11-07

## Contexte

Job `3c01d13f` (règle « squashacademie-mardi v2 », mardi 2026-11-10). Votes : Vinz, Mouss et
Ter à 18H45, Tin seul à 19H30, Seb volontaire « prête mon nom ». Plan réservé : court 4 de
18H45 à 21H00 pour le trio, plus une 4e ligne à 21H00 au nom de Seb + le joker, refusée par
TeamR (joker sans crédits). **Tin n'a eu aucun court** (« Pas assez de joueurs confirmés à
19H30 (1/2 requis) »).

Rejoué dans le moteur (`planJobBookings`), le plan prod se reproduit à l'identique ; avec des
préférences de temps de jeu ramenées à min 2 / max 3, la ligne de 21H00 disparaît mais Tin
reste sans court. La cause est structurelle :

1. **Le plan est calculé heure de vote par heure de vote.** Le groupe de 18H45 est figé (un
   court à 3) avant que l'heure 19H30 soit examinée.
2. **La fusion d'un retardataire** (`findMergeableSession`, règle du 2026-08-05) n'accepte que
   les sessions ayant une place libre : 3 + 1 > `maxPlayersPerCourt` (3), refus.
3. **Un prête-nom ne peut jamais ouvrir un 2e court** (règle du 2026-08-02), pour éviter un
   court occupé par une seule personne réelle. Ici le court de Tin n'aurait été « solo » que
   sur le papier : dès 19H30, 4 joueurs réels se répartissent sur 2 courts.

Or le squash se joue à 2 par court ; jouer à 3 est une rotation de dépannage. La priorité de
l'organisateur : **tous les inscrits jouent, avant le nombre de créneaux par personne.**

## Décision

Le moteur raisonne **créneau de 45 min par créneau de 45 min**, sur l'ensemble des joueurs
présents à ce créneau, toutes heures de vote confondues.

1. **Heure votée respectée.** Un joueur est présent à partir de son heure votée (après la
   cascade joueur seul → heure suivante, inchangée) ; il n'est jamais décalé plus tard pour
   équilibrer, et jamais placé plus tôt.
2. **Objectif = le minimum de chacun.** Les créneaux s'enchaînent tant qu'au moins un joueur
   présent est sous son minimum de temps effectif (préférences `/players`, `45 × 2/n` min par
   créneau à n joueurs sur un court). Le maximum reste un plafond, pas un objectif : aucun
   créneau n'est ajouté une fois tous les minima atteints.
3. **Nombre de courts par créneau** = `floor(présents / 2)` (un court à 3 si l'effectif est
   impair), borné par `maxCourtsPerSlot`, `maxPlayersPerCourt` et la disponibilité réelle.
   Un groupe garde son court d'un créneau à l'autre ; un court supplémentaire est pris dans
   l'ordre `courtPriority`.
4. **Noms TeamR.** Chaque ligne porte 2 noms distincts, chacun dans le plafond
   `maxDailyReservationsPerPlayer`. Ordre : joueurs réels, puis prête-noms volontaires du
   sondage (ADR-029), puis le joker en tout dernier recours. Un prête-nom ou le joker ne
   compte **jamais** dans l'effectif présent : il ne fait que compléter des noms, et n'est
   autorisé que si chaque court du créneau a au moins 2 joueurs réels.
5. **Crédits insuffisants.** Les noms sont attribués dans l'ordre chronologique : le manque
   retombe sur les derniers créneaux. Le créneau qui ne peut pas avoir tous ses courts en
   perd un (rotation à 3) ; au-delà de 3 joueurs pour les courts restants, les joueurs
   décident entre eux qui s'arrête (le moteur ne réserve que des courts).
6. **Lignes à risque d'abord.** À la réservation réelle, les lignes portées par un prête-nom
   ou le joker sont réservées **avant** toutes les autres. Si l'une est refusée après la
   cascade d'ADR-028, le plan est recalculé sans ce nom (les lignes de prête-nom déjà prises
   et absentes du nouveau plan sont annulées), puis le reste est réservé. Un refus du joker
   ne peut donc jamais rendre le résultat pire que le plan sans joker.

Ce modèle remplace la fusion cross-heures (2026-08-05) et l'interdiction absolue du
prête-nom pour un 2e court (2026-08-02), reformulée au point 4.

## Résultats attendus (tests de non-régression, scénario du 2026-11-10, courts libres)

Préférences : Vinz et Mouss min 2 / max 3, Ter et Tin min 2 / max 2 (défaut).

- **Avec Seb volontaire** : C4 18H45 Vinz+Mouss, C4 19H30 Vinz+Ter, C4 20H15 Mouss+Ter,
  C3 19H30 Tin+Seb, C3 20H15 Tin+Seb. Annonce : court 4 18H45-21H00, court 3 19H30-21H00.
- **Sans prête-nom ni joker** : C4 18H45 Vinz+Mouss, C4 19H30 Vinz+Ter, C3 19H30 Tin+Mouss,
  C4 20H15 Tin+Ter (4 joueurs pour un court à 20H15, l'un s'arrête). Annonce : court 4
  18H45-21H00, court 3 19H30-20H15.
- **Sans prête-nom, joker refusé par TeamR** : identique au cas précédent, Tin joue.

## Conséquences

- Refonte de `planJobBookings` (`apps/worker/src/planning/planJob.ts`) et de ses appuis
  (`sessionExtension.ts`, `groupBookingPlan.ts`) ; le simulateur (ADR-019) en hérite sans
  changement, puisqu'il appelle le même moteur.
- La réservation réelle (`reserveAllForReal`, `graph/nodes/announce.ts`) change d'ordre et
  gagne un recalcul du plan sur refus d'une ligne de prête-nom ou de joker.
- Les scénarios existants du simulateur et les tests de `planJob`/`groupBookingPlan` peuvent
  changer de résultat (par exemple plus de courts à 2, moins de rotations à 3) : chaque
  différence est revue avant merge, pas acceptée en bloc.
- Un prête-nom consomme 1 crédit par ligne, le joker aussi (ADR-028) : le plan à 5 lignes de
  l'exemple prend les 2 crédits de Seb.

## Hors périmètre

- Viser le maximum des préférences une fois tous les minima atteints.
- Le cas « file d'attente » (plus de joueurs que de places, même en rotation) : logique par
  couches conservée tant qu'elle ne contredit pas les points 1 à 6.
