# ADR-032 – Fermeture PUC déclarée tardivement : cascade d'arrêt portée par le worker, thread orphelin et relecture avant reprise

**Status:** accepted
**Date:** 2026-09-12

## Contexte

Les fermetures PUC (`club_closures`, design du 2026-08-09) n'étaient consultées qu'au SendPoll.
Une fermeture apprise **après** le lancement du sondage (tournoi du samedi 19 septembre 2026,
sondage déjà parti) laissait le job continuer : collecte, plan, « go », annonce — et réservation
réelle. Il fallait qu'une fermeture déclarée après coup **arrête le job en cours**, supprime le
sondage WhatsApp et prévienne le groupe avec la raison.

Trois choix d'architecture se posaient :

1. **Qui porte la création de la fermeture et la cascade ?** Jusqu'ici l'UI écrivait directement
   `club_closures` via Drizzle (`createClubClosure`). Or la cascade parle aux MCP (huddle-bot) et à
   LangGraph (stage du job), que seul le worker connaît.
2. **Que devient le thread LangGraph d'un job arrêté ?** Il est en pause sur un `interrupt()`
   (`waitForDecisionWindow`, `waitForPlanTrigger` ou `waitForGoConfirmation`).
3. **Comment empêcher qu'un « go » Telegram reçu après l'arrêt relance le graphe ?** Le
   long-polling `awaitGoAndResume` (jusqu'à 4 h) ne relisait jamais le job : un « go » tapé pour
   un autre job aurait repris l'annonce — et la réservation réelle — d'un job annulé.

## Décision

1. **Le worker porte la création et la cascade.** Deux routes internes :
   `POST /club-closures/preview` (lecture seule, impact sur les jobs en cours / prévus / en erreur)
   et `POST /club-closures` (insertion + cascade). L'UI `/settings` n'insère plus rien elle-même ;
   `createClubClosure` côté UI est supprimé. La suppression d'une fermeture reste une server action
   UI directe (aucun effet de bord).
   - L'impact est **recalculé au moment de la confirmation**, jamais repris de l'aperçu : la
     confirmation porte sur la fermeture, pas sur une sélection de jobs.
   - Un job est arrêté dès qu'**une** heure candidate tombe dans l'intervalle — une fermeture
     partielle arrête autant qu'une journée entière.
   - Cascade par job, ordre strict : `delete_message` (best effort) → message WhatsApp informel avec
     la raison → `cancelJobRun` **toujours** (même si le message a échoué) → événement `club-closed`
     → log Telegram. Chaque job est isolé (try/catch par itération) ; un échec après l'insertion
     répond `200` avec `cascadeError` pour que l'admin ne recrée pas la fermeture.
   - Les réservations TeamR ne sont **jamais** touchées (`cancel_reservation` jamais appelé) : soit
     le club n'est pas réservable, soit l'administrateur du PUC supprime lui-même les réservations.
2. **Le thread LangGraph reste en pause, orphelin.** Aucun `updateState`, aucune reprise : le job
   est marqué `cancelledAt` + `cancelReason` + `clubClosureId` en base, et tout ce qui reprend un
   graphe (`triggerCronDecision`, `recoverPendingGoWaits`, routes de déclenchement manuel) filtre
   déjà sur `cancelledAt`. Le checkpoint Redis expire ou reste inerte ; c'est acceptable au volume
   du projet et évite de coder un « chemin d'annulation » dans le graphe.
3. **Relecture du job avant toute reprise différée** (`isJobCancelledNow`) : après le retour du
   long-polling Telegram **et** sur le chemin rapide `go-real` (job auto sans confirmation, dont la
   fenêtre collecte → plan dure plusieurs secondes), le worker relit le job en base et refuse
   `graph.invoke` s'il est annulé, avec un log Telegram `"go" ignoré`. Le « go » consommé n'est pas
   rejoué (offset Telegram déjà persisté).

## Conséquences

- Nouvelle frontière : **l'UI ne fait plus d'écriture métier avec effets de bord sans passer par le
  worker.** Le pattern « server action Next.js → `callWorker` → route interne » devient la voie
  normale dès qu'un MCP ou LangGraph est impliqué.
- Les server actions concernées renvoient un `ActionResult<T>` (`{ ok, value } | { ok: false, error }`)
  au lieu de lever : Next.js masque en production le message des erreurs levées par une server
  action, et l'admin doit voir *pourquoi* une fermeture a échoué avant de réagir.
- `job_runs` gagne `cancel_reason` (texte lisible) et `club_closure_id` (FK `ON DELETE SET NULL`,
  historique). L'annulation manuelle du sondage laisse les deux à `null`.
- Le libellé de fermeture devient **obligatoire** à la création : il porte la raison dans les
  messages (`… le PUC est fermé samedi 19 septembre (tournoi) …`). Les fermetures existantes sans
  libellé restent valides, leurs messages omettent la parenthèse.
- Le non-objectif « recalcul d'un job déjà passé SendPoll » du design du 2026-08-09 est levé.
- Dette assumée : la relecture `getJobRunById` dans `isJobCancelledNow` n'est pas gardée — un échec
  DB à cet instant devient une rejection non gérée sur une promesse « fire-and-forget » (exposition
  préexistante sur `getTelegramUpdates`). À traiter avec un handler `unhandledRejection` global,
  hors de cette décision.
- Pas de test de composant pour le formulaire en deux temps (vitest UI n'inclut que les `.ts`) :
  une vérification manuelle sur le groupe de test est requise avant le premier usage réel.

## Références

- Design : `docs/superpowers/specs/2026-09-12-late-club-closure-design.md`
- Plan d'implémentation : `docs/superpowers/plans/2026-09-12-late-club-closure.md`
- Règles fonctionnelles : `docs/spec/regles-fonctionnelles.md` §2 (« Fermeture déclarée tardivement »)
- Design initial des fermetures : `docs/superpowers/specs/2026-08-09-club-closures-design.md`
