# ADR-025 – Résolution des identifiants joueurs à la couche présentation

**Status:** accepted
**Date:** 2026-09-02

## Contexte

Le moteur de plan local (`apps/worker/src/planning/*`, [ADR-018](./ADR-018-moteur-de-plan-de-reservation-local.md)) produit, en plus des réservations proposées, des **notes explicatives** en texte libre (`plan.warnings`) : effectif impair, plafond maison atteint, joueur pas réinscrit, prête-nom indisponible, groupe partiellement servi, joker mobilisé ([ADR-016](./ADR-016-prete-noms-substitution-quota-titulaire.md), [ADR-024](./ADR-024-joker-reservation-joueur-refuse.md)). Ces notes citent nécessairement des joueurs.

Le moteur est une fonction pure : il reçoit des ids resa-squash et des créneaux, aucun accès réseau, aucun annuaire. Ses tests (`planning/*.test.ts`, scénarios de régression, simulateur [ADR-019](./ADR-019-simulateur-scenarios-reservation.md)) s'appuient sur cette pureté et assertent sur des ids stables.

Conséquence : ses notes contiennent des ids bruts (`60bf46402d842c0027a508d4`). L'UI les résolvait déjà (`apps/ui/src/lib/formatWarning.ts`), mais **pas les messages sortants** — le plan Telegram de l'étape 3 et la synthèse WhatsApp affichaient des ids illisibles au milieu de phrases par ailleurs en français (voir [post-mortem `2026-09-02-ids-bruts-messages-sortants.md`](../post-mortem/2026-09-02-ids-bruts-messages-sortants.md)).

Deux façons de corriger :

1. **Injecter un résolveur de noms dans le moteur de plan** — il produirait directement des notes lisibles.
2. **Garder le moteur agnostique et résoudre au moment de l'affichage/envoi.**

## Décision

**Option 2.** Le moteur de plan reste agnostique de l'annuaire : ses notes citent les joueurs par id. La résolution id → nom est faite par chaque couche de présentation, là où l'annuaire du groupe (`list_group_members` resa-squash) est déjà chargé :

- **UI** : `resolvePlayerIdsInText` (`apps/ui/src/lib/formatWarning.ts`) → affiche `Nom (id)`.
- **Messages sortants** : `resolvePlayerIdsInText` (`apps/worker/src/graph/formatWarning.ts`) → affiche **le nom seul**, appliqué dans `bookSlots.ts` (plan Telegram) et `announce.ts` (synthèse WhatsApp).

Le format diffère volontairement selon la destination : dans l'UI l'id reste utile au debug, dans un message envoyé à des joueurs il n'est que du bruit. Un id absent de l'annuaire est laissé tel quel, même repli que `displayName`.

Corollaire, même logique appliquée à la règle elle-même : les messages envoyés la désignent par `BookingRule.name ?? id` (comme l'UI le fait depuis 2026-07-22), plus par son UUID technique. Les `console.error` du worker gardent l'`id`, qui est la clé de corrélation des logs.

## Raisons

- **Le moteur de plan doit rester pur et testable hors ligne.** Lui passer un annuaire ajouterait une dépendance à toutes ses fonctions et à toutes leurs signatures, et rendrait ses assertions dépendantes d'un mapping de noms — pour un bénéfice purement cosmétique.
- **Le format lisible dépend de la destination**, pas du calcul : `Nom (id)` dans l'UI, nom seul en WhatsApp. Le décider dans le moteur imposerait un format unique ou un paramètre de formatage dans la couche métier.
- **L'annuaire est déjà chargé côté présentation** (`fetchGroupMemberDirectory`) pour afficher les réservations : aucun appel MCP supplémentaire.
- **Réversible et local** : un seul point d'entrée par couche, une fonction de 3 lignes, aucun impact sur les données persistées (`jobRuns`, snapshots) qui continuent de stocker des ids — donc les jobs anciens restent relisibles.

## Conséquences

- Toute **nouvelle surface d'affichage** de `plan.warnings` doit appeler `resolvePlayerIdsInText` — c'est la contrepartie de ce choix, et le défaut qui a causé le bug initial (l'UI l'appliquait, les messages non). Règle consignée dans [`docs/spec/regles-fonctionnelles.md`](../spec/regles-fonctionnelles.md) §7 « Noms vs identifiants ».
- Deux implémentations quasi identiques cohabitent (UI et worker) : les workspaces sont séparés et le format de sortie diffère. Une factorisation dans `packages/db` (seul package partagé) n'est pas justifiée pour 3 lignes.
- Les notes restent stockées avec des ids : la résolution est faite à la lecture, donc un joueur renommé côté TeamR s'affiche avec son nom courant, y compris sur un job ancien.
