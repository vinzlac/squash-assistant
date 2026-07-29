# ADR-018 – Moteur de plan de réservation rapatrié côté squash-assistant

**Status:** accepted
**Date:** 2026-07-29

## Contexte

Depuis ADR-003, squash-assistant délègue l'intégralité du calcul du plan de réservation — apparier les joueurs par paire, choisir le court, gérer les groupes à effectif impair par rotation, substituer un prête-nom quand le titulaire de la clé API a atteint son quota quotidien de réservations, conserver une paire sur le même court d'un round à l'autre — à un unique appel d'outil MCP, `plan_group_bookings`, exposé par `resa-squash`. Cette logique d'allocation était donc une boîte noire côté squash-assistant : aucun test unitaire du repo ne pouvait l'exercer, seule une exécution réelle (ou un dry-run réseau) le pouvait.

Un bug de production a révélé les limites de cette boîte noire : quand un job comporte plusieurs "heures candidates" (ex. 18H45 et 19H30), `bookSlots.ts` appelait `plan_group_bookings` une fois par heure candidate, chaque appel ignorant les choix faits par l'autre. Il en résultait parfois deux paires de joueurs différentes proposées sur le **même court à des horaires qui se chevauchent** — un double-booking réel. Une première tentative de correction, basée sur une détection de conflit a posteriori (`busyCourtsDuring`/`conflictingSessionIds` calculés après coup sur les plans déjà produits), avait été mise en place mais restait fragile : elle détectait le problème après qu'il se soit produit dans les calculs, plutôt que de l'empêcher structurellement.

## Décision

### 1. Port fidèle du moteur d'allocation dans squash-assistant

L'algorithme d'allocation de `plan_group_bookings` est porté à l'identique dans `apps/worker/src/planning/` : cinq modules purs (`constants.ts`, `courtsNeeded.ts`, `pairing.ts`, `teamrTime.ts`, `courtAssignment.ts`) plus une fonction orchestratrice `groupBookingPlan.ts` (`computeGroupBookingPlan`). Le choix explicite est un **port fidèle d'abord** — reproduire le comportement existant à l'identique, y compris ses limitations connues — plutôt qu'une réécriture qui en profiterait pour corriger des règles au passage.

### 2. resa-squash redevient un service de réservation unitaire

`plan_group_bookings` n'est **pas retiré** de resa-squash — il reste utilisé tel quel par l'agent OpenClaw, qui l'appelle indépendamment (voir ADR-007 : coexistence délibérée, aucune fusion). Côté squash-assistant, resa-squash n'est plus sollicité que pour ses primitives de réservation unitaire, déjà existantes et inchangées : `list_availability` (disponibilité brute des courts/créneaux avec identifiants de session), `list_my_reservations_on_date` (quota quotidien du titulaire de la clé API), `reserve_slot`/`cancel_reservation` (réservation/annulation effective). Aucun changement de contrat MCP n'a été nécessaire côté resa-squash.

### 3. Élimination structurelle du double-booking

`apps/worker/src/graph/nodes/bookSlots.ts` récupère désormais `list_availability` et le quota du titulaire une seule fois par job (et non plus une fois par heure candidate), puis appelle le moteur local `computeGroupBookingPlan` une fois par heure candidate en faisant transiter un ensemble partagé `usedSessionIds` d'un appel à l'autre : un identifiant de session retenu par une heure candidate traitée plus tôt est filtré du pool disponible **avant même que l'appel du moteur pour l'heure candidate suivante ne s'exécute**. Le double-booking entre heures candidates devient ainsi structurellement impossible, plutôt que détecté après coup — le mécanisme `busyCourtsDuring`/`conflictingSessionIds` devient obsolète et est supprimé.

### 4. Règles de resa-squash délibérément non portées

Trois éléments de logique propres à resa-squash n'ont pas d'équivalent dans le moteur local, car squash-assistant les couvre déjà autrement :
- la vérification d'appartenance au groupe (hors périmètre du moteur d'allocation) ;
- les bornes min/max de créneaux par joueur pilotées par la base resa-squash (squash-assistant applique directement `BookingRule.maxReservationsPerPlayer`) ;
- le filtre de récurrence hebdomadaire (squash-assistant garantit déjà la bonne date cible via `targetWeekdayOffset`).

### 5. Bascule directe, sans flag ni phase de comparaison

Une fois les tests du moteur local au vert, `plan_group_bookings` cesse simplement d'être appelé par squash-assistant — pas de feature flag, pas de période de double-exécution en parallèle pour comparaison.

## Raisons

- Rendre la logique d'allocation testable unitairement dans squash-assistant : c'était la cause racine du bug (impossible d'écrire un test qui exerce l'algorithme sans dépendre du réseau/de resa-squash).
- Un port fidèle d'abord limite le risque : il isole le changement d'architecture (localiser le calcul) du changement de comportement (améliorer les règles), qui peut être traité ensuite, une fois le moteur sous test.
- Empêcher le double-booking par construction (filtrage du pool de sessions avant l'appel suivant) est plus robuste qu'une détection de conflit a posteriori, qui reste vulnérable à des cas non anticipés par les heuristiques de conflit.
- Conserver `plan_group_bookings` dans resa-squash évite tout impact sur OpenClaw, cohérent avec la décision de coexistence d'ADR-007 : aucune des deux implémentations ne dépend du cycle de vie de l'autre.

## Conséquences

- `apps/worker/src/planning/constants.ts`, `courtsNeeded.ts`, `pairing.ts`, `teamrTime.ts`, `courtAssignment.ts`, `groupBookingPlan.ts` : nouveaux modules purs portant l'algorithme d'allocation, chacun testable unitairement.
- `apps/worker/src/graph/nodes/bookSlots.ts` : récupère `list_availability` et le quota du titulaire une seule fois par job, appelle `computeGroupBookingPlan` par heure candidate en threadant `usedSessionIds` ; le mécanisme `busyCourtsDuring`/`conflictingSessionIds` est supprimé.
- resa-squash : aucun changement de contrat MCP — `plan_group_bookings` reste exposé et utilisé par OpenClaw, mais n'est plus appelé par squash-assistant.
- OpenClaw : aucun impact, conformément à ADR-007.
- Limitation connue héritée du moteur original (non corrigée par ce port, car hors du périmètre "port fidèle") : quand le titulaire de la clé API est substitué par un prête-nom faute de quota sur un round donné, la continuité de court de cette paire sur un round **ultérieur** est recalculée par rapport à l'identité d'origine de la paire, pas par rapport au prête-nom substitué — la continuité peut donc silencieusement se rompre dans ce cas précis. Ce n'est pas une régression introduite par le port ; c'est un comportement déjà présent dans l'algorithme resa-squash d'origine, dont la correction est explicitement différée.
- Rollout : bascule directe sans feature flag ni période de comparaison — une fois les tests verts, `plan_group_bookings` n'est simplement plus appelé.
- Détail technique complet : voir `docs/superpowers/specs/2026-07-29-local-group-booking-plan-engine-design.md` (design) et `docs/superpowers/plans/2026-07-29-local-group-booking-plan-engine.md` (plan d'implémentation en 12 tâches).
