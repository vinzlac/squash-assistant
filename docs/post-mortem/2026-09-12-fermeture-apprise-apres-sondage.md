# Fermeture du PUC apprise après le lancement du sondage

**Date :** 2026-09-12 (constat), 2026-09-13 (déploiement et validation)
**Périmètre :** `apps/worker/src/closures/*`, `apps/worker/src/scheduler/scheduler.ts`, `apps/worker/src/http/clubClosuresHandlers.ts`, `apps/ui/src/app/settings`
**Correctif :** commits `69df689..f1a0d11` puis `8cb7deb`, `4a4e364` — voir [ADR-032](../adr/ADR-032-fermeture-tardive-cascade-worker.md)

## Contexte

Les fermetures du PUC (`club_closures`, design du 2026-08-09) n'étaient consultées qu'au moment du
SendPoll : si la date cible était fermée, le worker envoyait un message à la place du sondage et
terminait le job. Ce design listait explicitement en non-objectif « recalcul d'un job déjà passé
SendPoll si une fermeture est ajoutée après coup ».

## Symptômes

Le 2026-09-12, Vincent apprend qu'un tournoi occupe les terrains le samedi 19 septembre. Le sondage
hebdomadaire pour cette date était **déjà parti** sur WhatsApp. Rien dans l'application ne
permettait de réagir :

- déclarer la fermeture dans `/settings` n'avait aucun effet sur le job en cours ;
- le job aurait enchaîné collecte des votes, plan, demande de « go » et, sur « go », **annonce et
  réservation réelle** de créneaux inutilisables ;
- le seul recours était « Annuler ce sondage » sur la page du job, qui supprime le sondage mais
  n'explique rien au groupe et laisse l'admin écrire lui-même un message.

Aucun dégât réel : le trou a été vu avant que le job ne dépasse la collecte des votes.

## Causes racines

1. **Fermeture consultée à un seul instant du pipeline.** Le SendPoll était le seul nœud à lire
   `club_closures`. Une fermeture est une information qui peut arriver à n'importe quel moment de
   la semaine ; la vérifier une fois au départ ne couvre pas le cas réel « on l'apprend tard ».
2. **Non-objectif assumé sans scénario concret.** Le design du 2026-08-09 excluait le recalcul après
   sondage par YAGNI, sans avoir cherché quel événement métier rendrait ce cas fréquent. Un tournoi
   ou une manifestation communiqués la veille par le club sont pourtant le cas courant d'une
   fermeture.
3. **Pas de garde-fou sur la reprise différée d'un job.** Indépendamment des fermetures, le
   long-polling Telegram « go » (`awaitGoAndResume`, jusqu'à 4 h) et le chemin rapide `go-real` des
   jobs auto reprenaient le graphe **sans relire le job en base** : un job annulé entre-temps (par
   n'importe quel moyen) pouvait encore être annoncé et réservé. Le bug existait avant la feature,
   c'est elle qui l'a rendu visible.

## Correctif

Voir [ADR-032](../adr/ADR-032-fermeture-tardive-cascade-worker.md) pour les décisions. En résumé :

- création de fermeture en **deux temps** dans `/settings` (aperçu des jobs impactés, confirmation),
  portée par le worker via `POST /club-closures/preview` et `POST /club-closures` ;
- **cascade par job** en cours dont une heure candidate est couverte : suppression du sondage
  (best effort), message informel au groupe avec la raison, annulation du job avec la cause,
  événement, Telegram — réservations TeamR jamais touchées ;
- **relecture du job avant toute reprise différée** (`isJobCancelledNow`), sur le poller Telegram
  et sur le chemin rapide, *fail closed* si la base est injoignable ;
- libellé de fermeture obligatoire, `cancel_reason` et `club_closure_id` sur `job_runs`.

## Ce que l'implémentation a révélé

La feature a été livrée par sous-agents avec revue à chaque tâche puis revue de branche. Quatre
défauts du **plan** (pas de l'implémentation) n'ont été attrapés que par ces revues :

| Défaut du plan | Attrapé par | Conséquence évitée |
|---|---|---|
| Une exception (pas un `ok:false`) dans la boucle de cascade rendait un 500 et perdait les résultats partiels | revue tâche 7 | un job sur deux non arrêté sans que l'admin le sache |
| Les server actions **levaient** les erreurs ; Next.js les masque en production | revue tâche 9 | l'admin ne saurait jamais *pourquoi* une fermeture a échoué |
| « Pas de fenêtre d'entrelacement » sur le chemin rapide `go-real` — faux, la fenêtre collecte → plan dure plusieurs secondes | revue de branche | réservation réelle d'un job annulé, exactement ce que la feature doit empêcher |
| Un échec **après** l'insertion de la fermeture rendait un 500 nu | revue de branche | l'admin recrée la fermeture en double, cascade jamais exécutée sur la première |

Plus un défaut de test : `vi.clearAllMocks()` laissait fuir un `mockRejectedValue` d'un test à
l'autre ; l'implémenteur l'a remplacé par `vi.resetAllMocks()`.

## Leçons

- **Une information métier qui peut arriver à tout moment doit être revérifiée à chaque reprise du
  pipeline**, pas seulement au nœud qui la consomme en premier. Relire l'état en base juste avant
  toute reprise différée est maintenant la règle (`isJobCancelledNow`), et elle vaut pour toute
  future cause d'annulation.
- **Un non-objectif doit citer le scénario qu'il écarte.** « Recalcul après sondage » aurait dû être
  confronté à « le club annonce un tournoi la veille », ce qui l'aurait fait passer en objectif.
- **« Pas de fenêtre de course » est une affirmation à prouver, pas à écrire.** Compter les appels
  réseau entre la décision et l'action ; s'il y en a un, il y a une fenêtre.
- **Une server action Next.js qui doit expliquer un échec à l'utilisateur renvoie un résultat, elle
  ne lève pas.** Pattern `ActionResult<T>` désormais en place pour les actions à effets de bord.
- **Pour un test qui configure des mocks par cas, `resetAllMocks` en `beforeEach`.** `clearAllMocks`
  ne remet pas les implémentations.

## Vérifications

- `npm run typecheck` OK, `npm test` OK (403 tests, 4 workspaces).
- Validation manuelle par Vincent le 2026-09-13 sur le site public (`squash-assistant.code-advisors.site`,
  image `f1a0d11`, migration 0026 appliquée par l'initContainer) : aperçu, confirmation, sondage
  supprimé dans WhatsApp, message informel reçu avec la raison, page du job avec la cause, « go »
  Telegram envoyé ensuite ignoré. Tout a fonctionné.
