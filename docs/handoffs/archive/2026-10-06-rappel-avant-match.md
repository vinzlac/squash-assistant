# Handoff — squash-assistant — 2026-10-06

**Agent source** : Claude Code · **Branche** : main · **HEAD** : dc345fc

## Objectif
Concevoir (spec + plan, sans code) un **rappel WhatsApp le jour du match**, ~2 h (±10 min) avant le premier créneau réservé, même contenu que la confirmation étape 5 (terrains, heures, joueurs, QR) dans le groupe de confirmation. Raison : jusqu'à 5 jours séparent la confirmation (jour de la décision) du match, on oublie.

## État actuel
- **Conception terminée et commitée, aucune ligne de code produit écrite.** Constaté : aucun rappel calé sur l'heure des créneaux n'existait dans le code.
- Spec : `docs/superpowers/specs/2026-10-05-rappel-avant-match-design.md` (commit `332bd44`, ajustée dans `dc345fc`).
- Plan : `docs/superpowers/plans/2026-10-05-rappel-avant-match.md` (commit `dc345fc`), 8 tâches TDD.
- Trois relectures par agents indépendants (approche, section 2, spec écrite) et une du plan, corrections appliquées.
- **L'utilisateur a demandé d'attendre son « go » explicite avant de lancer l'implémentation par sous-agents.** Ne pas démarrer sans.

## Décisions prises
- Un seul rappel par job, avant le **premier** créneau réservé — **parce que** l'utilisateur veut un récap unique (Q1).
- Destinataire = groupe de confirmation (`resolveConfirmationNotifyJid`), pas de nouveau champ (Q2) ; délai réglable par règle, défaut 120, bornes 30–360 (Q3).
- Tick global `* * * * *` plutôt que `setTimeout` posé à l'annonce ou cron par règle — **parce que** l'heure dépend des créneaux pris et doit survivre aux redémarrages. À consigner dans ADR-036 (Task 8).
- Réservation atomique de la ligne `job_runs` **avant** `sendMessage` (remise à NULL si échec) — **parce que** `replicas: 1` sans `strategy` : deux pods coexistent en déploiement progressif.
- Heure de Paris par `Intl` en minutes, jamais `slotStartDateIsoHeuristicParis` — **parce qu'elle applique « +02:00 d'avril à octobre »**, faux après le 25/10/2026 (rappel décalé d'une heure).
- Décalage ±10 min dérivé d'un hash FNV-1a de l'id du job, rien stocké.
- Pas de rappel si `decisionDaysBefore = 0` ; dry-run : envoi seulement si le destinataire ≠ groupe du sondage (titre « dry-run — aucun court réservé », sans QR).
- Réglages lus sur la règle live ; contenu du message sur le snapshot du job (écart assumé avec la confirmation).
- Étape 6 : « En attente de l'annonce » tant que le match est à venir ; log Telegram « non annoncé » seulement pour les jobs bloqués ; rappel manqué = « Non envoyé (créneau commencé) ».
- Seed : ne pas ajouter les champs à `packages/db/seeds/booking-rules.seed.json`.

## Approches abandonnées
- `setTimeout` à l'annonce — abandonnée : perdu au redémarrage (attente jusqu'à 5 jours), reprise au boot à écrire.
- Un rappel par heure de début — écartée par l'utilisateur (Q1).
- Logique de l'étape 6 dupliquée côté UI — abandonnée : le worker calcule `startReminder` dans `handleJobStatus`, l'UI affiche seulement.

## Fichiers créés ou modifiés
- `docs/superpowers/specs/2026-10-05-rappel-avant-match-design.md` — spec.
- `docs/superpowers/plans/2026-10-05-rappel-avant-match.md` — plan d'implémentation.
- `docs/handoffs/current.md` (ce fichier) ; ancien handoff archivé dans `docs/handoffs/archive/2026-10-05-confirmation-groupe-distinct.md` (autre objectif). Les deux sont non commités.

## Commandes importantes
```bash
npm run typecheck && npm test
(cd packages/db && npm run build)   # requis avant typecheck des autres workspaces
(cd packages/db && npm run db:generate -- --name start_reminder)   # Task 1
npm run worker:test -- <fichier>
```

## Tests
- Aucun test lancé cette session (conception uniquement). Dernier résultat connu (handoff précédent, avant la feature) : typecheck et `npm test` passés pour v1.1.0.

## Erreurs rencontrées
- Aucune erreur d'exécution. Les relectures ont trouvé et fait corriger dans le plan : build `packages/db` en échec si `realRules.ts` n'est pas complété avant, `dryRun` manquant dans un littéral de test, `graphify-out` ignoré par git dans un `git add`.

## Hypothèses à vérifier
1. HYPOTHÈSE: `START_REMINDER_SINCE = 2026-10-06T00:00:00Z` est antérieure à la mise en prod — à ajuster à la date réelle dans le commit de release.
2. À VÉRIFIER: `parseTeamrTime` accepte « 9H00 » sans zéro (regex `\d{1,2}H\d{2}`, lu) ; le format réel renvoyé par TeamR n'a pas été confirmé.
3. À VÉRIFIER: tests et commandes du plan jamais exécutés ; la relecture les a seulement confrontés au code.

## Prochaines actions (ordonnées)
1. Attendre le « go » de l'utilisateur.
2. Exécuter le plan en sous-agents (`superpowers:subagent-driven-development`), tâche par tâche, avec relecture avant la suivante.
3. Commiter ce handoff et son archive si demandé ; `git pull --ff-only` (1 commit CI possible sur origin) et pousser quand l'utilisateur le décide.
4. Après déploiement : activer le rappel sur une règle dont la confirmation va vers le groupe de test, surveiller l'étape 6 puis le message le jour du match.

## Questions ouvertes
- Message d'annulation pour fermeture du club (`apps/worker/src/closures/cancelJobForClosure.ts:56`) : part toujours au groupe d'origine. Non demandé, non modifié.
- `ruleDescription.ts` annonce la confirmation même quand `nextDayReminderEnabled` est faux. Hors périmètre, noté dans la spec.
- Masquer « Groupe de confirmation » quand la case est décochée : non traité.

## Skills / outils suggérés pour la suite
- `superpowers:subagent-driven-development` (exécution choisie), `graphify query` avant tout grep large, `/release` ensuite (arbre propre et main synchronisé exigés).

## État Git
- Branche : main · HEAD : dc345fc · Working tree : `docs/handoffs/` non suivi
- Non commité : `docs/handoffs/current.md` et `docs/handoffs/archive/…`
- Non poussé : 2 commits (`332bd44`, `dc345fc`) ; origin/main avait 1 commit CI de plus au dernier fetch (`1d0999e`, déjà intégré localement)
