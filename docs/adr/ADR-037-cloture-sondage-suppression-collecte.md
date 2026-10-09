# ADR-037 – Clôture du sondage par suppression du message WhatsApp à la collecte

**Status:** accepted
**Date:** 2026-10-09
**Spec:** [2026-10-09-cloture-sondage-recap-inscrits-design.md](../superpowers/specs/2026-10-09-cloture-sondage-recap-inscrits-design.md)

## Contexte

Le sondage restait votable après la collecte (étape 2). Sur le job 04578758, deux votes arrivés après la collecte n'ont jamais été pris en compte, sans que personne ne le sache. WhatsApp n'offre pas de fermeture native d'un sondage. Après `delete_message`, huddle-bot retire le sondage de son store et `get_responses` renvoie « aucune_reponse » pour tous, **sans erreur** : toute relecture après suppression produirait silencieusement un plan vide.

## Décision

1. La question du sondage annonce l'heure de clôture (date cible − `decisionDaysBefore`, à `decisionTime`, règle live à l'envoi).
2. À la collecte : lecture des votes, puis suppression du sondage (`delete_message`) et `job_runs.poll_closed_at`. Rien n'est supprimé si la lecture échoue. Un échec de suppression est signalé sur Telegram (désépinglage tenté) sans bloquer l'étape.
3. Un sondage fermé n'est jamais relu : une relance de l'étape reprend les votes du dernier événement `collect_votes` réussi, sinon échec explicite. « Relire les réponses » est retiré ; l'annulation du sondage est refusée après clôture.
4. Suppression seulement si le groupe de l'annonce est le groupe du sondage (sinon mode test : désépinglage seul) et si le sondage réellement envoyé annonçait sa clôture (`detail.question` de l'événement `poll` contient « réponses jusqu'au »). Pas de date de mise en service à régler : un sondage parti avant le déploiement, ou dont la mention a été omise, n'est que désépinglé. `poll_closed_at` est écrit avant `delete_message` et remis à null si la suppression échoue.
5. Un récap WhatsApp des inscrits remplace le sondage dans le groupe de l'annonce, épinglé jusqu'au premier créneau réservé du jour du match (tick à la minute d'ADR-036, requête dédiée sur `recap_msg_id`), immédiatement désépinglé à l'annulation, et nettoyé au sondage suivant.

## Alternatives écartées

- Fermeture différée (garder le sondage ouvert jusqu'au plan) : la collecte et le plan partent ensemble en auto, et un vote tardif resterait invisible.
- Relecture après suppression : impossible, `get_responses` ne distingue pas un sondage supprimé d'un sondage sans réponse.
- Message « sondage clos » en réponse au sondage sans le supprimer : le sondage resterait votable.

## Conséquences

- Migration `0033` : `job_runs.poll_closed_at`, `job_runs.recap_msg_id`, `job_runs.recap_jid`. Appliquée par l'initContainer ([ADR-012](./ADR-012-migrations-automatiques-initcontainer.md)).
- Le groupe voit « message supprimé » à la place du sondage.
- En mode test, un vote tardif reste possible dans le vrai groupe et n'est pas pris en compte ; la fermeture effective arrive quand l'annonce bascule sur le groupe du sondage.
- WhatsApp garde au plus 3 messages épinglés par groupe : une règle en utilise au plus 2 (récap + annonce) ; plusieurs règles sur un même groupe peuvent faire tomber le plus ancien sans prévenir.
- Le récap n'affiche que des noms (`lookup_player_by_phone`, état `voterNames`), jamais d'identifiant resa-squash.
- Limite connue : si le worker est tué entre la suppression du sondage et l'envoi du récap, le récap n'est pas renvoyé à la relance (choix « rien en double » plutôt que doublon).
- Les téléphones des votants non identifiés sont enregistrés dans le détail de l'événement `collect_votes` : le sondage n'existant plus, c'est la seule source pour les rechercher à nouveau au « Recalculer le plan ».
- Limite connue : le Telegram « échec de désépinglage du récap » est dédupliqué en mémoire seulement ; il peut se répéter après un redémarrage du pod.
