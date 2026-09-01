# ADR-024 – Joker de réservation quand TeamR refuse un joueur

**Status:** accepted
**Date:** 2026-09-01
**Révisé:** 2026-09-01 — règle du joker corrigée après retour terrain (voir « Correction »)

## Contexte

Deux causes font échouer un `reserve_slot` pour une raison qui tient au **joueur**, pas au créneau :

1. **Joueur pas réinscrit.** Au 1er septembre, la liste des licenciés TeamR repart de zéro et se remplit au fil des réinscriptions. resa-squash marque désormais les licenciés non réinscrits en suppression logique et **leur interdit de réserver** (resa-squash ADR-011). Un groupe WhatsApp, lui, continue de voter avec ses membres habituels : en septembre, une partie d'entre eux ne peut pas encore réserver.
2. **Quota atteint.** TeamR refuse (crédits / nombre max de réservations) pour un joueur donné — bug réel constaté le 2026-08-26 : un `noCredits` en cours de lot faisait échouer toute la réservation.

Jusqu'ici, ces deux refus produisaient le même résultat : `reserveAllForReal` levait, le rollback best-effort annulait les réservations déjà faites du lot, et le groupe recevait « échec de la réservation automatique, aucun court n'a été réservé ». Une soirée entière tombait à cause d'**un** joueur, alors que les courts étaient libres et que les autres joueurs pouvaient réserver.

Le club dispose d'un joueur qui n'a ni l'un ni l'autre problème : le **gérant**, sans plafond de réservations et toujours inscrit. C'est exactement le rôle d'un prête-nom, mais les `substituteBookers` existants (ADR-016) ne conviennent pas tels quels : ils sont **consommés pour la journée** (un prête-nom qui joue réellement à une autre heure n'est jamais proposé, et chacun ne sert qu'une fois), alors que le gérant peut porter autant de réservations qu'on veut dans la journée.

Enfin, jusqu'à resa-squash ADR-011, rien ne permettait de **distinguer par programme** ces deux refus d'un « créneau déjà pris » : `callTool` ne remontait qu'un message texte. resa-squash expose maintenant un `reason` stable.

## Décision

### 1. `BookingRule.jokerBookerId: string | null` (défaut `null`) — **par règle**, pas global

Un seul userId, pas une liste ordonnée : le joker est un rôle (le gérant), pas une file d'attente. `null` = pas de joker, comportement historique strictement inchangé.

**Portée par règle** (colonne de `booking_rules`) et non réglage global (`app_settings`), pour deux raisons : c'est la portée de tous les paramètres de réservation voisins (`substituteBookers`, `maxDailyReservationsPerPlayer` — ADR-016), et elle permet d'activer le joker sur un groupe sans l'imposer aux autres (un groupe peut préférer un échec visible à une réservation au nom de quelqu'un d'autre). Le coût est de le re-saisir par règle ; c'est une valeur qui change rarement, et la même personne dans toutes les règles reste un choix possible, pas une contrainte.

**Choisi parmi les favoris du compte resa-squash**, pas parmi les membres du groupe : le gérant du club est un joueur des favoris et n'est pas nécessairement membre du groupe WhatsApp concerné. Le worker expose `GET /favorites` (`list_my_favorites`), et resa-squash n'y renvoie que les joueurs **réinscrits** — donc le vivier proposé est exactement celui des jokers valides. Repli sur une saisie libre du userId si la liste est indisponible (MCP injoignable) ; un joker déjà enregistré mais absent des favoris reste sélectionné (option « hors favoris ») plutôt qu'effacé en silence.

Champ distinct de `substituteBookers` plutôt qu'une extension de celui-ci, parce que les deux règles de consommation sont opposées : un prête-nom est consommé pour la journée, alors que le joker **ne se consomme pas du tout**. Le gérant peut figurer en **partenaire** sur autant de réservations qu'on veut, y compris plusieurs au même horaire — la seule condition est que le **titulaire** de la ligne soit, lui, bien inscrit.

### 2. `McpToolError` : le `reason` remonte jusqu'au worker

`callTool` (`apps/worker/src/mcp/client.ts`) lève désormais un `McpToolError` portant `reason` et `details`, extraits du bloc JSON que resa-squash place dans `content` en cas d'erreur. Un serveur qui ne renverrait rien de tel donne `reason: null` — aucune régression.

C'est ce **code** qui pilote la substitution, jamais le texte du message : un message en français est une donnée d'affichage, pas un contrat.

### 3. Substitution au plan **et** à la réservation

`reserveAllForReal` retente la ligne refusée au nom du joker et retourne la liste des substitutions effectuées. Règles (implémentées dans `planning/jokerSubstitution.ts`, sans effet de bord — le module décide *qui* remplacer, il n'appelle rien) :

- **Déclencheurs** : `PLAYER_NOT_REGISTERED` et `PLAYER_BOOKING_LIMIT_REACHED` seulement. `SLOT_ALREADY_BOOKED` et `TEAMR_BOOKING_REJECTED` ne sont pas substituables — changer de nom n'y changerait rien.
- **Cible** : le joueur désigné par `details.players` quand resa-squash le connaît (cas `PLAYER_NOT_REGISTERED`) ; sinon (quota TeamR, qui ne dit pas lequel des deux joueurs est en cause) on tente les deux formes, remplacement du partenaire d'abord, promotion ensuite. `reserve_slot` est atomique : un essai infructueux ne laisse rien derrière lui.
- **Le joker est toujours en partenaire, jamais titulaire** : c'est la position où il est sans limite, et elle suppose un titulaire inscrit. Un titulaire refusé n'est donc pas remplacé *par* le joker (qui deviendrait titulaire) : le partenaire, lui valide, est **promu titulaire** et le joker prend sa place. Si les deux joueurs sont refusés, il n'y a aucun titulaire valide à opposer — le refus redevient un échec normal (rollback du lot, message WhatsApp existant).
- **Aucune limite de nombre**, y compris au même horaire.

### 4. Signalement sur Telegram, pas sur WhatsApp

Les substitutions partent sur le canal organisateur. Même posture que l'ADR-016 pour les prête-noms : le nom porté par TeamR n'intéresse pas les joueurs (une ligne à 2 noms pour 3 joueurs en rotation est déjà la norme), mais l'organisateur doit savoir que la réservation n'est pas au nom du joueur attendu.

## Raisons

- **Réserver malgré tout est le comportement attendu du produit.** squash-assistant remplace la personne qui gérait les réservations à la main ; cette personne, face à un joueur qui ne peut pas réserver, mettait un autre nom — elle n'annulait pas la soirée.
- **Substituer à la réservation plutôt qu'à la planification** : le quota TeamR n'est connaissable qu'au moment de l'appel (le moteur local ne voit que les réservations du titulaire de la clé API). Un seul point de traitement pour les deux causes, au moment où l'information existe vraiment, plutôt qu'un pré-filtrage partiel côté plan doublé d'un rattrapage côté réservation.
- **Un `reason` plutôt qu'un parsing de message** : c'est le contrat que resa-squash s'est donné en ADR-011, et la seule façon de ne pas casser au premier changement de formulation TeamR.
- **Ne pas réutiliser `substituteBookers`** : leurs règles de consommation sont contradictoires. Les fusionner obligerait à porter un "type" par entrée — plus de complexité qu'un champ dédié.

## Conséquences

- Migration `0023_joker_booker.sql` : `booking_rules.joker_booker_id text` (nullable, pas de défaut) — appliquée automatiquement par l'initContainer du worker (ADR-012).
- `packages/db` : `schema.ts`, `ruleDescription.ts` (phrase décrivant le joker), `fixtures/realRules.ts`, `seeds/booking-rules.seed.json`.
- `apps/worker` : `mcp/client.ts` (`McpToolError`), `planning/jokerSubstitution.ts` (+ test), `graph/nodes/announce.ts` (`reserveAllForReal` exportée et testée, message Telegram), `llm/ruleParamsExtraction.ts` (champ **optionnel** du schéma d'extraction : une description sans joker ne doit pas pousser le modèle à en inventer un).
- `apps/worker/src/http/server.ts` : `GET /favorites` (userId → nom, depuis `list_my_favorites`).
- `apps/ui` : liste déroulante des favoris sur `RuleForm` (pas un `MemberPicker` — le gérant n'est pas nécessairement membre du groupe), `lib/worker.ts` (`getFavoriteNames`), pages `rules/new` et `rules/[id]/edit`, `actions.ts` (chaîne vide → `null` ; favoris fusionnés aux membres pour résoudre le nom du joker dans la description mise en cache), `RuleGeneratorPanel.tsx`.
- `docs/spec/regles-fonctionnelles.md` §6.
- **Non traité** : afficher les substitutions dans l'UI (étape 4) et dans le rappel J+1 — l'information part sur Telegram, comme les prête-noms de l'ADR-016 ; à rouvrir si l'usage montre que l'organisateur la cherche ailleurs.
- **Traité depuis la révision du 2026-09-01** (voir « Extension au plan » ci-dessous) : les joueurs non réinscrits sont substitués dès le plan.

## Correction (2026-09-01, même jour)

La première rédaction posait deux contraintes qui n'existent pas en réalité : que le joker ne pouvait porter qu'**une** réservation par créneau horaire (« on ne peut pas être sur deux courts à la même heure »), et qu'il pouvait indifféremment remplacer le titulaire ou le partenaire.

Retour de l'exploitant du club : le gérant peut être mis **en partenaire sur autant de créneaux qu'on veut, y compris plusieurs au même horaire** — la seule condition est que le **premier joueur de la ligne (le titulaire) soit bien inscrit**. La limite « un court à la fois » vaut pour un joueur ordinaire, pas pour ce cas.

Conséquences appliquées : suppression de la classe `JokerAvailability` (plus de suivi par créneau), et `substitutionCandidates` place désormais le joker **exclusivement en partenaire** — un titulaire refusé déclenche la **promotion du partenaire en titulaire** plutôt qu'un joker titulaire. Cas nouvellement explicite : les deux joueurs refusés → aucun titulaire valide, pas de substitution possible.

Ce que ça change en pratique : à la rentrée, plusieurs joueurs non réinscrits sur un même horaire ne font plus tomber le lot — chaque ligne concernée est reprise avec le joker en partenaire.

## Extension au plan (2026-09-01)

La première version ne substituait qu'**à la réservation** : le plan de l'étape 3 affichait le joueur réel, et la correction n'apparaissait qu'à l'étape 4. Acceptable pour le quota (invisible avant l'appel TeamR), mais inutilement tardif pour la réinscription — `list_group_members` porte `isRegistered`, donc l'information existe **avant** de planifier.

Le plan applique donc maintenant la même règle en amont : un joueur non réinscrit voit sa ligne attribuée au joker directement dans `proposedBookings`. Ce qui s'affiche à l'étape 3 est ce qui sera réservé.

- La décision « où va le joker » reste **une seule implémentation** (`substitutionCandidates`), réutilisée par `applyJokerToPair` pour le plan. Pas de règle dupliquée entre les deux moments.
- Les **trois** chemins d'émission de réservations du moteur local sont couverts : cas courant (`scheduleGroupTimeline`), cas file d'attente (`computeQueueingCasePlan`), et prolongation cross-heures (`extendSessionForLateJoiners`). Un seul des trois aurait laissé un trou selon la configuration du groupe.
- Le joker est **exclu du contrôle de plafond de résas/jour** : sans ça, il aurait été remplacé par un prête-nom au bout de deux lignes.
- Sans joker configuré, la paire est écartée du plan avec un warning, plutôt que proposée pour échouer à l'étape 4.
- `list_group_members` indisponible → aucun joueur considéré comme non réinscrit, planification inchangée. Un statut absent ne doit jamais faire croire qu'un joueur ne peut pas réserver ; la substitution à la réservation reste le filet.

La substitution **à la réservation est conservée** : elle seule couvre le quota TeamR, et elle rattrape un changement de statut survenu entre le plan et le « go ».

## Lecture du joker sur la règle live (2026-09-01)

Constat au premier job réel : la synthèse annonçait « aucun joker configuré sur la règle » alors que la règle en portait un. Cause — l'état du graphe fige `bookingRule` au **lancement du sondage** (étape 1) et les étapes suivantes reprennent depuis le checkpoint LangGraph ; un joker configuré après l'envoi du sondage restait donc ignoré pendant toute la semaine du job.

`jokerBookerId` est désormais relu sur la règle **live** aux étapes 3 et 4 (`resolveLiveJokerBookerId`), exactement comme `reservationNotifyWhatsappGroupJid` l'est déjà pour le destinataire d'annonce : ce sont tous deux des réglages **opérationnels**, pas des paramètres de plan dont le figeage sert la traçabilité (ADR-014). Une règle live introuvable ou une erreur de lecture retombe sur la valeur figée ; un `jokerBookerId` live explicitement `null` fait foi (joker retiré depuis la création du job).
