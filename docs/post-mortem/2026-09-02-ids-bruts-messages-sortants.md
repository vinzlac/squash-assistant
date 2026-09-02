# Identifiants joueurs bruts dans les messages Telegram et WhatsApp

**Date :** 2026-09-02
**Périmètre :** `apps/worker/src/graph/nodes/bookSlots.ts`, `apps/worker/src/graph/nodes/announce.ts`
**Correctif :** commit `26cdbf4` — voir [ADR-025](../adr/ADR-025-resolution-ids-joueurs-couche-presentation.md)

## Contexte

Le plan de réservation envoyé sur Telegram à l'étape 3, et la synthèse vote/réservation envoyée sur WhatsApp à l'étape 4, contiennent deux choses : les créneaux proposés, et les **notes explicatives** du moteur de plan (`plan.warnings`) qui disent pourquoi tel joueur n'a pas eu de créneau.

## Symptômes

Message reçu pour le job du 2026-09-08 :

```
19H30 : aucun créneau (Effectif impair : 60bf46402d842c0027a508d4 intégré au groupe du court
le mieux classé. 60e7777dbc53560027fe49ef : pas réinscrit(s) — réservation ignorée (19H30),
aucun joker configuré sur la règle. Groupe 60e23b69a78d1100206b808c+60e7777dbc53560027fe49ef+
60bf46402d842c0027a508d4 : 0/3 round(s) réservé(s).)
```

Les créneaux réservés, eux, affichaient correctement « Vincent LACOSTE et Sébastien LIGNEUL » — c'est ce contraste dans le **même message** qui rendait le défaut visible. En-tête du message : `[b2b5106f-5d0a-479c-9ea2-d67e32f07dba]`, l'UUID de la règle.

## Causes racines

1. **Résolution des noms appliquée aux réservations, pas aux notes.** `bookSlots.ts` et `announce.ts` définissaient bien un `displayName` (annuaire `fetchGroupMemberDirectory`) et l'appliquaient à `proposedBookings[].userId` / `.partnerId`, mais interpolaient `plan.warnings` telles quelles (`g.plan.warnings.join(" ")`). Les notes sont produites par `planning/*`, qui n'a volontairement pas accès à l'annuaire (cf. ADR-025) et cite donc les joueurs par id.
2. **Correctif déjà existant, appliqué à une seule couche.** L'UI avait déjà `resolvePlayerIdsInText` (`apps/ui/src/lib/formatWarning.ts`) pour exactement ce problème, utilisé par `Pipeline.tsx` et `ScenarioEditor.tsx`. La couche « messages sortants » ne l'a jamais eu — le besoin identique n'avait pas été généralisé.
3. **Règle désignée par son id technique.** Les messages interpolaient `bookingRule.id` alors que `BookingRule.name` existe depuis 2026-07-22 et sert de libellé partout dans l'UI (`name ?? id`).

## Correctif

- Nouveau `apps/worker/src/graph/formatWarning.ts` — `resolvePlayerIdsInText(text, names)`, pendant côté worker du helper UI. Différence assumée : l'UI affiche `Nom (id)`, les messages n'affichent que le nom (l'id n'est que du bruit pour des joueurs). Id inconnu de l'annuaire → laissé tel quel, même repli que `displayName`.
- Appliqué aux `plan.warnings` dans `bookSlots.ts` (branche « aucun créneau ») et `announce.ts` (les deux branches de la synthèse).
- `bookingRule.name ?? bookingRule.id` dans tous les messages **envoyés** (Telegram et WhatsApp). Les `console.error` gardent l'`id`, clé de corrélation des logs.
- Écrit en TDD : `formatWarning.test.ts` — id seul, groupe joint par `+`, id inconnu, annuaire vide.

## Vérifications

- `npm run typecheck` OK, `npm test` OK (242 tests worker, + db + ui).
- Rendu vérifié sur le message réel qui a servi de reproduction : `Groupe Terence CHIARADIA+Tin LAM+Martin MERLOT : 0/3 round(s) réservé(s).`

## Enseignements

- **`plan.warnings` est du texte destiné à un humain, produit par une couche qui ne connaît pas les humains.** Toute nouvelle surface qui l'affiche doit passer par `resolvePlayerIdsInText` — sinon le défaut réapparaît, exactement comme ici. Consigné dans `docs/spec/regles-fonctionnelles.md` §7.
- **Un helper créé pour l'UI répond souvent aussi à un besoin worker.** Le bug a vécu parce que la correction existait déjà à un seul endroit : au moment d'écrire `formatWarning.ts` côté UI, la question « qui d'autre affiche ces warnings ? » n'a pas été posée.
- **Piège de diagnostic rencontré** : l'UUID en tête de message a d'abord été pris pour un id joueur non résolu. Ce sont deux formats distincts — joueurs = 24 caractères hex sans tiret (resa-squash/TeamR), règles = UUID v4 avec tirets (`randomUUID()` à la création via l'UI). Corollaire : l'UUID affiché ne disait rien de l'état de `BookingRule.name`, puisque le code déployé ne lisait jamais ce champ.
