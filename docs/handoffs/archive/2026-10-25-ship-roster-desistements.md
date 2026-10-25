# ship-feature — roster-desistements

- Branche : `feat/roster-desistements` (worktree `.worktrees/roster-desistements`)
- Base : `main` @ 3a69133 — merge : `ask` (pas de ligne `merge:` dans CLAUDE.md)
- Besoin : /Users/vinz/workspace/squash-assistant/.worktrees/roster-desistements/docs/besoins/2026-10-24-roster-desistements.md
- Spec : docs/superpowers/specs/2026-10-24-roster-desistements-design.md (à écrire)
- Plan : docs/superpowers/plans/2026-10-24-roster-desistements.md (à écrire)
- Baseline (base) : `npm test` 686 verts (listener 53, ui 31, worker 553, db 49) ; `npm run typecheck` OK ; pas de lint

## Phases

- [x] 0. Préflight — commit 050119d `docs(besoin): roster-desistements`
- [x] 1. Spec — écrite ; Q1/Q2/Q3 tranchées par Vinz (liste des oui sans plafond ; Telegram échecs seuls ; CA-9 amendé < 48 h supprimé sinon désépinglé). Besoin amendé (non commité, à commiter avec la spec au gate)
- [~] 2. Review spec — R1 : 0 crit / 9 imp / 11 min (rapport scratchpad review-spec-r1.md). Mécaniques appliqués : R1-1, 8, 9, 12, 13, 14, 15, 17, 19, 20. Décisions en attente : R1-2, R1-3 (+R1-4), R1-5, R1-6, R1-7, R1-10, R1-16, R1-18. Phase 2 à rejouer après le gate.
  Gate 1 (Vinz) : plafond = lettre du besoin + heure sans court ; dry-run toujours republié ; confirmation/rappel alignés roster ; ligne « changer d'heure ». Défauts techniques pris : R1-2 A, R1-3 A, R1-7 A, R1-10 A, R1-16 C.
  R2 : 0 crit / 6 imp / 11 min. Mécaniques appliqués R2-1, 5–17. Décisions ouvertes : R2-2 (fermeture PUC après collecte), R2-3 (échec de retrait de l'ancien roster), R2-4 (identité votant @lid). Targeted check à faire après.
  Gate 2 (Vinz) : R2-2 < 48 h supprimé sinon désépinglé ; R2-3 ne pas épingler le nouveau ; R2-4 vérifier puis nom. Vinz veut relire la spec avant de valider.
  Check1 : 0/0/8 min → C1-1,2,3,5,6,7,8 appliqués. Check2 : 0/0/3 min → C2-2, C2-3 appliqués. Ouverts (mineurs, décisions) : C1-4 (@lid sans nom correspondant), C2-1 (orphelin épinglé après échec de retrait). 1 targeted check restant (max 3) avant commit.
  Gate 3 (Vinz, 2026-10-25) : « je valide les 2 » → spec validée, C2-1 A (orphelin mémorisé), C1-4 A (JID + Telegram). Check3 : 0/0/4 min (C3-1..4, mécaniques, NON appliqués à la spec : limite de 3 checks atteinte → à intégrer au plan).
- [x] 3. Gate — spec + besoin commités 7047577
- [x] 4. Plan + review — commit 0049632. R1 0/3/18, R2 0/2/14, checks 1/2/3 : 0/1/9, 0/0/7, 0/0/5. Décisions prises par défaut (hors intention spec) : P1-2 A, P1-5 A, P1-19 A, PC1-10 A. Mineurs PC3-1..5 NON appliqués au plan (limite de checks) → à transmettre aux implémenteurs : PC3-1 (lookup seulement si option non nulle, tâche 9), PC3-2 (test remplissage identités nom:/jid:, tâche 9), PC3-3 (désépinglage du sondage si la copie de règle épingle, tâche 12), PC3-4 (setRosterPinnedAt(null) même si unpinOnly échoue, expiresAt calculé avant, tâche 6), PC3-5 (limite défaut A dans les Conséquences de l'ADR-038, tâche 14). Note : requête prod en lecture refusée par le classifieur → tâche 1 = SQL que Vinz lance avant merge.
- [x] 5. Exécution — 14 tâches, commits 585d7ee..7933a00, chaque tâche relue (opus), ledger .superpowers/sdd/2026-10-24-roster-desistements/progress.md. Suite : db 49, listener 53, worker 746, ui 29, typecheck OK.
- [x] 6. Review branche — R1 0/5/8 (fix 1 + décisions Vinz B1-4 a, B1-7 b, B1-8 b), R2 0/1/4 (décision Vinz B2-1), check1 0/0/2. Convergé. HEAD 8824bce. Suite : db 53, listener 29, worker 766, ui 49, typecheck OK. Requête prod (B1-5) OK. Ouverts : 3 retraits vides (2e requête), BC1-1 (mineur, décision), BC1-2 (mineur), B1-9 (doute timeout huddle-bot).
- [x] 6bis. Après phase 6 : retraits vides — R2-16 révisée (option a, données de prod : 1 désistement réel, 1 changement vers « Non », 1 artefact) ; BC1-1 (b) la fin d'un roster figé s'applique. Relecture de branche entière R1 : 0/1/5 (BR1-1 important = spec fausse, code inatteignable ; BR1-3 claim à l'heure réelle ; BR1-4 un Telegram par votant @lid), vérification ciblée 0/0/4. Décisions de Vinz : D1 a (corriger la doc, code inchangé car inatteignable), D2 a, D3 b (limite BR1-2 documentée).
- [x] 7. Merge — `--no-ff` dans main le 2026-10-25, merge commit ea141e0, poussé (CI `Build and push` 40217482949). Tests sur main : db 49, listener 53, worker 784, ui 29, typecheck OK.
- [x] 8. Clôture — branche `feat/roster-desistements` et worktree supprimés ; ce fichier archivé.

## Décisions ouvertes

Aucune. Limites acceptées : BC1-2 (« roster non envoyé » peut être faux sur un « busy » de l'annonce), B1-9 (doute : timeout huddle-bot après livraison), BR1-2 (un votant `nom:` avec téléphone n'est pas réidentifié au « Recalculer le plan »), set des Telegram déjà envoyés en mémoire.

## Dernier commit

ea141e0 (merge)
