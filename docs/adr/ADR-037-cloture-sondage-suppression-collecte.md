# ADR-037 – Clôture du sondage par suppression du message WhatsApp à la collecte

**Status:** accepted
**Date:** 2026-10-09
**Spec:** [2026-10-09-cloture-sondage-recap-inscrits-design.md](../superpowers/specs/2026-10-09-cloture-sondage-recap-inscrits-design.md)

## Contexte

Le sondage restait votable après la collecte (étape 2). Sur le job 04578758, deux votes arrivés après la collecte n'ont jamais été pris en compte, sans que personne ne le sache. WhatsApp n'offre pas de fermeture native d'un sondage. Après `delete_message`, huddle-bot retire le sondage de son store et `get_responses` renvoie « aucune_reponse » pour tous, **sans erreur** : toute relecture après suppression produirait silencieusement un plan vide.

## Décision

1. La question du sondage annonce l'heure de clôture (date cible − `decisionDaysBefore`, à `decisionTime`, règle live à l'envoi). Mention omise si cette clôture est passée ou tombe à plus de `POLL_DELETE_MAX_AGE_HOURS` (48 h) de l'envoi : le garde-fou d'âge (point 5) empêcherait la suppression, la mention serait fausse. Même règle dans l'aperçu UI.
2. À la collecte : lecture des votes, puis suppression du sondage (`delete_message`) et `job_runs.poll_closed_at`. Rien n'est supprimé si la lecture échoue. Un échec de suppression est signalé sur Telegram (désépinglage tenté) sans bloquer l'étape.
3. Un sondage fermé n'est jamais relu : une relance de l'étape reprend les votes du dernier événement `collect_votes` réussi, sinon échec explicite. « Relire les réponses » est retiré ; l'annulation du sondage est refusée après clôture.
4. Suppression seulement si le groupe de l'annonce est le groupe du sondage (sinon mode test : désépinglage seul) et si le sondage réellement envoyé annonçait sa clôture (`detail.question` de l'événement `poll` contient « réponses jusqu'au »). Pas de date de mise en service à régler : un sondage parti avant le déploiement, ou dont la mention a été omise, n'est que désépinglé. `poll_closed_at` est écrit avant `delete_message` et remis à null si la suppression échoue.
4bis. **Lecture vide suspecte** : `get_responses` renvoie « aucune_reponse » pour tous, sans erreur, si huddle-bot a redémarré entre l'envoi et la collecte (store mémoire vide). Si personne n'a répondu quoi que ce soit (`respondentCount === 0`, pas même « Non »), rien d'irréversible : pas de suppression, `poll_closed_at` reste null, désépinglage seul, pas de récap WhatsApp, alerte Telegram ; le pipeline continue (plan vide). Des réponses sans inscrit restent un cas normal.
5. **Garde-fou d'âge** : WhatsApp ne permet la suppression « pour tout le monde » que pendant ~60 h. Au-delà de `POLL_DELETE_MAX_AGE_HOURS = 48` h depuis l'événement `poll` du job (ou si sa date est introuvable), pas de suppression : `poll_closed_at` reste null, désépinglage seul, Telegram invitant à supprimer à la main.
6. **Relance après clôture** : les votes sont repris de l'événement `collect_votes`. Les Telegram de collecte (« Confirmés par heure », votants non identifiés) sont renvoyés à partir de ces votes, jamais de WhatsApp. Une suppression réussie (à la collecte ou à la relance) est tracée par un événement `poll_deleted` (best-effort) : s'il existe, rien n'est retenté ni signalé. Sinon, même garde-fou d'âge qu'au point 5 (au-delà de 48 h ou date introuvable : pas de nouvelle tentative, Telegram invitant à vérifier à la main), puis `delete_message` est retenté en best-effort ; tout échec (« Message not found » compris : sans `poll_deleted`, indiscernable d'un store huddle-bot vidé par un redémarrage) est signalé sur Telegram, et le sondage est désépinglé en best-effort (de même quand la suppression n'est pas retentée) ; `poll_closed_at` n'est jamais remis à null. Pas de récap renvoyé.
7. Un récap WhatsApp des inscrits remplace le sondage dans le groupe de l'annonce, épinglé jusqu'au premier créneau réservé du jour du match (tick à la minute d'ADR-036, requête dédiée sur `recap_msg_id`), immédiatement désépinglé à l'annulation, et nettoyé au sondage suivant.

## Alternatives écartées

- Fermeture différée (garder le sondage ouvert jusqu'au plan) : la collecte et le plan partent ensemble en auto, et un vote tardif resterait invisible.
- Relecture après suppression : impossible, `get_responses` ne distingue pas un sondage supprimé d'un sondage sans réponse.
- Message « sondage clos » en réponse au sondage sans le supprimer : le sondage resterait votable.

## Conséquences

- Nouveau type d'événement `poll_deleted` (colonne `events.type` en `text` : pas de migration), libellé « suppression du sondage » dans l'historique des jobs.
- Migration `0033` : `job_runs.poll_closed_at`, `job_runs.recap_msg_id`, `job_runs.recap_jid`. Appliquée par l'initContainer ([ADR-012](./ADR-012-migrations-automatiques-initcontainer.md)).
- Le groupe voit « message supprimé » à la place du sondage.
- En mode test, un vote tardif reste possible dans le vrai groupe et n'est pas pris en compte ; la fermeture effective arrive quand l'annonce bascule sur le groupe du sondage.
- WhatsApp garde au plus 3 messages épinglés par groupe : une règle en utilise au plus 2 (récap + annonce) ; plusieurs règles sur un même groupe peuvent faire tomber le plus ancien sans prévenir.
- Le récap n'affiche que des noms (`lookup_player_by_phone`, état `voterNames`), jamais d'identifiant resa-squash, ni téléphone ou JID (caractères de format Unicode invisibles retirés d'abord ; un numéro glissé dans un nom WhatsApp est retiré sans ponctuation orpheline ; une plage d'années comme « 2024-2025 » est conservée). La synthèse du groupe test passe les noms des volontaires non identifiés par le même nettoyage (`publicVoterName`).
- Quand le sondage du groupe n'a pas été supprimé (ancien sondage, garde-fou d'âge, `msgId` inconnu, échec), le récap titre « 📋 Inscrits » au lieu de « 🔒 Inscriptions closes » (mode test : titre conservé, clôture simulée).
- Au « Recalculer le plan », une recherche resa-squash en échec est signalée « recherche en échec » et distinguée d'un numéro inconnu ; le recalcul n'est pas bloqué.
- Limite connue : si le worker est tué entre la suppression du sondage et l'envoi du récap, le récap n'est pas renvoyé à la relance (choix « rien en double » plutôt que doublon).
- Les téléphones des votants non identifiés sont enregistrés dans le détail de l'événement `collect_votes` : le sondage n'existant plus, c'est la seule source pour les rechercher à nouveau au « Recalculer le plan ».
- Limite connue : le Telegram « échec de désépinglage du récap » est dédupliqué en mémoire seulement ; il peut se répéter après un redémarrage du pod.
