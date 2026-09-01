# ADR-024 – Joker de réservation quand TeamR refuse un joueur

**Status:** accepted
**Date:** 2026-09-01

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

Champ distinct de `substituteBookers` plutôt qu'une extension de celui-ci, parce que les deux règles de consommation sont opposées : un prête-nom est consommé pour la journée, le joker est réutilisable — mais **au plus une fois par créneau horaire**, puisqu'on ne peut pas être sur deux courts à la même heure.

### 2. `McpToolError` : le `reason` remonte jusqu'au worker

`callTool` (`apps/worker/src/mcp/client.ts`) lève désormais un `McpToolError` portant `reason` et `details`, extraits du bloc JSON que resa-squash place dans `content` en cas d'erreur. Un serveur qui ne renverrait rien de tel donne `reason: null` — aucune régression.

C'est ce **code** qui pilote la substitution, jamais le texte du message : un message en français est une donnée d'affichage, pas un contrat.

### 3. Substitution à la réservation, pas à la planification

`reserveAllForReal` retente la ligne refusée au nom du joker et retourne la liste des substitutions effectuées. Règles (implémentées dans `planning/jokerSubstitution.ts`, sans effet de bord — le module décide *qui* remplacer, il n'appelle rien) :

- **Déclencheurs** : `PLAYER_NOT_REGISTERED` et `PLAYER_BOOKING_LIMIT_REACHED` seulement. `SLOT_ALREADY_BOOKED` et `TEAMR_BOOKING_REJECTED` ne sont pas substituables — changer de nom n'y changerait rien.
- **Cible** : le joueur désigné par `details.players` quand resa-squash le connaît (cas `PLAYER_NOT_REGISTERED`) ; sinon (quota TeamR, qui ne dit pas lequel des deux joueurs est en cause) on tente le partenaire puis le titulaire. `reserve_slot` est atomique : un essai infructueux ne laisse rien derrière lui.
- **Un seul nom remplacé par ligne** : joker + joker n'a pas de sens.
- **Un joker par créneau horaire** ; épuisé, le refus redevient un échec normal (rollback du lot, message WhatsApp existant).

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
- **Non traité** : écarter les joueurs non réinscrits **dès le plan** (resa-squash expose pourtant `isRegistered` sur `list_group_members`). Ça éviterait d'afficher à l'étape 3 un plan qui sera corrigé à l'étape 4, mais ça ne remplace pas la substitution (le quota reste invisible avant l'appel) — à traiter séparément si le plan proposé s'avère trompeur en pratique.
