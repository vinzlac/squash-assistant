# Planification par groupes et rounds — Implementation Design

**Status:** Draft — en attente de revue utilisateur avant plan d'implémentation.

## 1. Contexte et problème

Le moteur local de calcul du plan de réservation (`apps/worker/src/planning/`) porte fidèlement l'algorithme de `resa-squash` : il apparie les joueurs confirmés 2 par 2 (`pairing.ts`), calcule un nombre de courts nécessaires (`courtsNeeded.ts`), puis remplit des "couches" (*layers*, une par créneau visé par joueur, `rule.maxReservationsPerPlayer`) dans `groupBookingPlan.ts`. Si l'effectif est impair, le dernier joueur ("rotatingPlayerId") est ajouté **après coup**, en couche séparée, via `sessionExtension.ts::extendSessionForLateJoiners` — un mécanisme qui pondère le temps de jeu effectif par présence round par round (`playerJoinTimes`, `cumulativeEffectiveMinutes`).

Deux défauts concrets, observés sur un scénario réel (règle `squash-samedi-matin`, 7 joueurs confirmés + 1 prête-nom) :

1. **Couches rigides** : chaque couche doit être complète pour TOUTES les paires avant que la suivante démarre, et l'algorithme cherche toujours l'horaire le plus tôt où la couche complète (taille = `courtsNeeded`) tient d'un coup — sans jamais réessayer une taille réduite à un horaire plus tôt. Résultat : des courts libres restent inutilisés à certains horaires alors qu'ils pourraient accueillir un round.
2. **Rotation ajoutée après coup, sur une session déjà figée** : le joueur en rotation est intégré **après** que les paires classiques ont déjà fini leurs couches — ce qui l'oblige à des rounds supplémentaires en fin de session au lieu d'être intégré dans les créneaux déjà libres pendant la session.

Sur le cas réel (7 joueurs, 3 courts, plafond 2 créneaux/joueur) : le plan produit 4 rounds (10H30→13H30, 3h) alors que 3 rounds (10H30→12H45, 2h15) suffisent — calcul détaillé : 7 joueurs × 90 min visées = 630 joueur-minutes ; un créneau de 45 min produit toujours 90 joueur-minutes (2 joueurs jouent réellement à tout instant, que le court ait 2 ou 3 personnes en rotation) ; donc 630/90 = 7 créneaux nécessaires, sur 3 courts → ⌈7/3⌉ = 3 rounds.

**Simplification produit actée avec l'utilisateur** : le moteur n'a pas besoin de savoir précisément *qui* joue à *quel* round pour un groupe de 3 en rotation — les joueurs s'arrangent physiquement entre eux une fois que les courts sont réservés. Le moteur doit seulement garantir un **nombre total de rounds réservés suffisant** pour que chacun atteigne en moyenne son temps de jeu visé.

**Point additionnel confirmé** : les préférences individuelles de temps de jeu (`/players`, `player_preferences`, `resolvePlayerPlaySlots` — "Option B", déjà en base) doivent s'appliquer à **toutes** les paires/groupes, pas seulement au joueur en rotation comme c'est le cas aujourd'hui (bug annexe découvert pendant ce design : un membre de paire classique avec `minSlots=3` n'a aujourd'hui aucun effet sur le plan).

## 2. Portée

**Dans le périmètre** :
- Intégrer le joueur en rotation (effectif impair, un seul possible — `pairing.ts` ne produit jamais plus d'un `rotatingPlayerId`) dans un groupe dès le calcul initial, pas après coup.
- Calculer le nombre de rounds nécessaires par groupe (2 ou 3 joueurs) à partir d'une formule globale (pas de suivi de présence round par round), en tenant compte des préférences individuelles (`playerPlaySlots`).
- Nommer les 2 joueurs sur la ligne TeamR de chaque round via un cycle round-robin fixe pour les groupes de 3 (pas de calcul de présence).
- Corriger l'irrégularité "couches rigides" **dans le cas courant où le nombre de groupes tient dans `courtsNeeded`** (aucune file d'attente entre groupes nécessaire) — c'est le cas de tous les scénarios rapportés jusqu'ici.
- Simplifier `sessionExtension.ts::extendSessionForLateJoiners` (toujours utilisé par `planJob.ts` pour le cas des votes tardifs à une heure candidate **ultérieure** — cas différent, conservé) pour utiliser le même principe (rounds totaux, pas de présence pondérée).

**Hors périmètre (limitation connue, non traitée ici)** :
- Le cas où le nombre de groupes **dépasse** `courtsNeeded` (ex. 4 paires classiques pour seulement 3 courts simultanés) reste géré par une logique de type "couches" proche de l'existant. C'est un problème d'ordonnancement multi-machines (minimiser le makespan) plus complexe et non demandé par les bugs rapportés — noté comme piste de travail future, pas traité par ce design.
- Aucun changement du contrat MCP resa-squash, ni du type `GroupBookingPlan` exposé en aval (UI, `announce.ts`, etc.).

## 3. Nouveau modèle : `Group`

Nouveau fichier `apps/worker/src/planning/groups.ts` :

```typescript
export interface Group {
  /**
   * 2 joueurs (paire classique) ou 3 (paire + joueur en rotation fusionné).
   * Pour un groupe de 3, ordonné par `minSlots` décroissant (position 0 = le
   * plus exigeant) — l'ordre conditionne le calcul de `roundsNeeded` (§3) et
   * le nommage TeamR par round (§4), qui indexent tous les deux `members`.
   */
  members: string[];
  /** Nombre de rounds de 45 min à réserver sur le court de ce groupe. */
  roundsNeeded: number;
}
```

**Construction** (`buildGroupsForBooking(expected, substitutes, playerPlaySlots, playSlotsDefaults, slotsPerPlayer): { groups: Group[]; warnings: string[] }`) :

1. Appelle `buildPairsForGroupBooking(expected, substitutes)` (inchangé) → `pairs`, `rotatingPlayerIds` (0 ou 1 élément), `remainingSubstituteIds`.
2. Si `rotatingPlayerIds` a un élément, le fusionne dans la **première** paire (`pairs[0]`) pour former un groupe de 3 — choix déterministe et simple, cohérent avec `courtPriority` qui place déjà cette paire sur le court le mieux classé. Les autres paires restent des groupes de 2.
3. Pour chaque groupe, calcule `roundsNeeded` :
   - Groupe de 2 : `roundsNeeded = max(resolvePlayerPlaySlots(m).minSlots pour m dans members)` — comme aujourd'hui côté "slotsPerPlayer", mais maintenant sensible aux préférences individuelles (corrige le bug annexe §1).
   - Groupe de 3 : le round-robin fixe `[[0,1],[0,2],[1,2]]` (répété en cycle) ne donne pas le même rythme d'apparition aux 3 positions sur un cycle incomplet — la position 0 (et 1) rattrape son quota plus vite que la position 2. On **trie les 3 membres par `minSlots` décroissant** et on les assigne aux positions `[0,1,2]` dans cet ordre (le plus exigeant en position 0), puis on simule le cycle round par round (compteur de présence par position) jusqu'à ce que chaque position ait atteint le `minSlots` de son membre. Évite le surdimensionnement d'un arrondi à un cycle complet : ex. Vincent (3) + Hugo (2) + David (2) → 4 rounds suffisent (positions 0 et 1 atteignent 3 présences dès le round 4, position 2 a déjà 2) au lieu de 6 avec un arrondi à cycle complet. Cas courant (les 3 veulent `minSlots=2`) : 3 rounds, comme calculé manuellement par l'utilisateur.
4. Un warning si `rotatingPlayerIds` n'est pas vide (comme aujourd'hui) mais reformulé : *"Effectif impair : {id} intégré au groupe du court {N} (rotation, {roundsNeeded} rounds réservés au lieu de {slotsPerPlayer})."*

## 4. Nommage TeamR par round — round-robin fixe

Nouvelle fonction pure dans `groups.ts` :

```typescript
/** Index dans `members` des 2 joueurs nommés sur la ligne TeamR pour un round donné du groupe. */
export function teamrNamesForRound(groupSize: 2 | 3, roundIndex: number): [number, number] {
  if (groupSize === 2) return [0, 1];
  const cycle: Array<[number, number]> = [[0, 1], [0, 2], [1, 2]];
  return cycle[roundIndex % 3]!;
}
```

Le remplacement par prête-nom en cas de plafond quotidien (`maxDailyReservationsPerPlayer`) reste géré comme aujourd'hui (vérifie chaque nom retenu, substitue si besoin, warning si aucun prête-nom disponible) — logique reprise telle quelle depuis `pickTeamrNamesForExtension`, simplifiée pour ne plus dépendre de `session.pairUserId`/`pairPartnerId` (remplacés par les 2 index du round-robin).

## 5. Remplissage des rounds — `computeGroupBookingPlan`

Remplace la double boucle couches + extension post-hoc par :

1. `buildGroupsForBooking(...)` → `groups`.
2. `courtsNeeded` : calcul **inchangé** (`courtsNeededForPlayers` sur le headcount total, capé par `maxCourts`/`SQUASH_COURT_COUNT`) — reste une estimation haute, sans conséquence si elle dépasse `groups.length` (le remplissage ne consomme jamais plus de courts que de groupes actifs).
3. **Cas courant** (`groups.length <= courtsNeeded`, aucune file d'attente nécessaire) : chaque groupe reçoit sa **propre timeline continue** de `roundsNeeded` créneaux consécutifs disponibles, indépendamment des autres groupes — plus de notion de couche synchronisée. Le court est choisi une fois par `courtPriority`/continuité (comme `resolveCourtAssignments` aujourd'hui) et conservé pour tous les rounds du groupe.
4. **Cas file d'attente** (`groups.length > courtsNeeded`) : conserve le comportement actuel par couches (hors périmètre, cf. §2) — code existant déplacé mais non réécrit.
5. Warnings `maxDailyReservationsPerPlayer`, fenêtre de disponibilité, etc. : logique reprise telle quelle par round, appliquée aux 2 noms du round-robin au lieu des 2 noms de paire fixes.

## 6. Simplification de `sessionExtension.ts`

`extendSessionForLateJoiners` (cas différent, conservé : vote tardif à une heure candidate ultérieure, fusion dans une session déjà en cours via `planJob.ts`) :

- Retire `playerJoinTimes`, `cumulativeEffectiveMinutes`, `playersPresentAtSlot`, `allPlayersMeetEffectiveMin`, `playersShortOfMin`.
- Remplace par : nouveau `roundsNeeded` du groupe élargi (formule §3, sur `session.players` élargi aux late joiners), continue de réserver des rounds consécutifs jusqu'à `roundsNeeded` atteint (au lieu de "tous les joueurs atteignent leur minutes effectives").
- Nommage TeamR par round via `teamrNamesForRound` (au lieu de `pickTeamrNamesForExtension` orienté "paire d'origine puis candidats").
- `OngoingSession` perd les champs `playerJoinTimes`, `pairUserId`/`pairPartnerId` (remplacés par `members: string[]`).

## 7. Fichiers touchés

| Fichier | Changement |
|---|---|
| `apps/worker/src/planning/groups.ts` | **Nouveau** — `Group`, `buildGroupsForBooking`, `teamrNamesForRound` |
| `apps/worker/src/planning/groups.test.ts` | **Nouveau** |
| `apps/worker/src/planning/groupBookingPlan.ts` | Réécrit : utilise `groups.ts`, remplace couches+extension-post-hoc par remplissage par groupe (cas courant) / couches existantes (cas file d'attente) |
| `apps/worker/src/planning/groupBookingPlan.test.ts` | Nouveaux cas (7 joueurs/3 courts avec préférences individuelles), scénarios existants réexécutés (régression) |
| `apps/worker/src/planning/sessionExtension.ts` | Simplifié (retire le suivi de présence pondérée, garde la fusion cross-heure) |
| `apps/worker/src/planning/sessionExtension.test.ts` | Nouveau (n'existait pas — testé aujourd'hui uniquement via `groupBookingPlan.test.ts`/`planJob.test.ts`) |
| `apps/worker/src/planning/planJob.ts` | Adapté aux nouveaux types `OngoingSession`/`Group` si besoin (appel `extendSessionForLateJoiners` inchangé côté signature) |
| `apps/worker/src/planning/pairing.ts` | Inchangé |
| `apps/worker/src/planning/courtsNeeded.ts` | Inchangé |
| `apps/worker/src/planning/courtAssignment.ts` | Inchangé (réutilisé tel quel pour le choix de court par groupe) |
| `docs/spec/regles-fonctionnelles.md` | §4 mis à jour (nouveau modèle de groupes, formule de rounds, portée des préférences individuelles) |

## 8. Tests

- `groups.test.ts` : `buildGroupsForBooking` (fusion du rotator dans la 1ère paire, formule `roundsNeeded` avec/sans préférences individuelles, cas 0 rotator) ; `teamrNamesForRound` (cycle correct pour groupe de 2 et de 3).
- `groupBookingPlan.test.ts` : reprendre tous les scénarios existants (régression — en particulier "8 joueurs, plafond 3 courts" qui reste en mode file d'attente, comportement inchangé) + nouveau scénario exact du bug rapporté (7 joueurs, 3 courts, 3 rounds attendus, fin à 12H45) + nouveau scénario préférence individuelle (un membre de paire classique avec `minSlots=3`, doit obtenir 3 rounds).
- `sessionExtension.test.ts` (nouveau) : fusion cross-heure avec le nouveau modèle de rounds.
- Scénarios de régression existants (`scenarios.regression.test.ts`, fixtures `__fixtures__/scenarios/*.json`) : à rejouer, mise à jour attendue si le texte des warnings change (comme lors du fix précédent sur `sessionExtension.ts`).

## 9. Question ouverte pour la revue

Le choix "fusionner le rotator dans la **première** paire" (donc systématiquement le court le mieux classé en `courtPriority`) est le plus simple à implémenter et cohérent avec le comportement observé aujourd'hui. Une alternative (fusionner dans la paire dont un membre a déjà la préférence `minSlots` la plus haute, pour aligner rotation et appétit de jeu) est possible mais ajoute de la complexité pour un bénéfice marginal — proposé comme non retenu sauf avis contraire.
