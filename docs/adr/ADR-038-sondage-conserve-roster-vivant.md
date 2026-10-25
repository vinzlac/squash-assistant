# ADR-038 – Sondage conservé et roster vivant

**Status:** accepted
**Date:** 2026-10-25
**Spec:** [2026-10-24-roster-desistements-design.md](../superpowers/specs/2026-10-24-roster-desistements-design.md)
**Amende:** [ADR-037](./ADR-037-cloture-sondage-suppression-collecte.md) (points 1 à 7, pour les nouveaux jobs) et [ADR-034](./ADR-034-epinglage-whatsapp-sondage-annonce.md) (points 2 à 4).

## Contexte

Le sondage était supprimé à la collecte (ADR-037) et le groupe recevait un récap figé « 🔒 Inscriptions closes ». Ensuite, toute la vie de la session passait par des messages texte : désistements, « on est combien ? », et Vinz qui coordonne à la main qui prend la place de qui. Le 2026-10-24, Laurent est venu sans s'inscrire, faute de sondage. Cela arrive au moins deux fois par mois.

Le but est de prolonger le pipeline jusqu'au jour J : le sondage reste le **seul canal d'inscription et de désistement**, et le groupe voit en permanence un **roster à jour** (qui joue à quelle heure, places libres, liste d'attente, remplacements).

Contraintes WhatsApp : un sondage envoyé ne se modifie pas ; une édition de message n'est visible que ~15 min ; la suppression « pour tous » n'est possible que 48 à 60 h (`POLL_DELETE_MAX_AGE_HOURS = 48` réutilisé) ; au plus 3 messages épinglés par groupe.

## Décision

1. **Sondage conservé.** La collecte ne supprime plus le sondage et n'écrit plus `poll_closed_at`. La question n'annonce plus de clôture. Le sondage reste épinglé et est désépinglé avec le roster, au début du premier créneau réservé (tick à la minute, ADR-036). La lecture vide suspecte (ADR-037, point 4bis) reste une erreur avant toute action.
2. **État des votes = photo de collecte ⊕ événements de vote.** La photo (lue à la collecte, complétée du téléphone et du `votedAt` de chaque votant et des `event_id` déjà en base, lus **avant** `get_responses`) est suivie des événements `poll_vote_*` du sondage persistés par le listener, appliqués dans l'ordre d'arrivée en base (`created_at`, puis `event_id`). Un événement dont `occurredAt` n'est pas postérieur au dernier vote connu du votant est ignoré. Clé de votant : `tel:+<chiffres>`, sinon `jid:`, sinon `nom:`. Un « Non » de la collecte qui revote « oui » est recherché dans resa-squash (PC1-4) ; un faux retrait (aucune option avant ni après) est ignoré avec un Telegram.
3. **Les votes tardifs entrent dans le plan.** Les votes sont recalculés avant chaque calcul de plan. L'instant `T_plan`, l'état des votes et les `event_id` intégrés sont mémorisés en base : ils forment la base du roster définitif.
4. **Roster provisoire** à la place du récap (sans plafond, sans « 🔒 »), sur le groupe de l'annonce, republié à chaque changement de vote jusqu'à l'annonce. Ligne 🙏 des prête-noms : les identifiés d'abord, puis les non identifiés, chaque groupe par ordre d'arrivée.
5. **Roster définitif** à la place de l'annonce des courts (réel ou dry-run), avec plafond par heure égal au nombre de « oui » retenus à `T_plan`, places libres, liste d'attente par heure et mentions « (remplace X) » (règles d'attribution du §4.6 de la spec). Une heure sans court réservé a un plafond 0. Le roster remplace l'annonce : en mode roster l'annonce n'est plus épinglée à part, c'est le roster qui l'est.
6. **Publication par le tick à la minute**, sous claim en base (écrivain unique), seulement si l'empreinte du texte change. Ordre : envoyer le nouveau, mémoriser son `msgId`, retirer l'ancien (supprimé s'il a moins de 48 h, sinon désépinglé), épingler le nouveau. Après l'envoi, tout échec (suppression, épinglage, désépinglage, Telegram) est best-effort. Fin au début du premier créneau réservé.
7. **Roster orphelin épinglé.** Si le désépinglage de l'ancien roster échoue, il est mémorisé avec l'expiration de son épinglage (date d'épinglage + `PIN_DURATION = "7d"`). Aucun roster n'est épinglé tant qu'il existe. À chaque tick, son désépinglage est retenté ; à la reprise, l'orphelin est oublié dès que son épinglage a expiré, sans appel. L'épinglage normal du roster courant reprend dès l'orphelin oublié, qu'il ait été désépinglé ou qu'il ait expiré.
8. **Jobs en erreur et jobs annulés.**
   - Un job en erreur qui a des courts réservés et un roster définitif (`rosterFinal`) n'est jamais retiré : son roster définitif est republié jusqu'au premier créneau, pour qu'une publication ou un Telegram en échec n'efface pas le roster de courts réels. Un job en erreur sans roster définitif voit son roster provisoire retiré.
   - Un job annulé (fermeture PUC) ne publie plus et ne réépingle plus aucun roster ; le roster est retiré après l'écriture de l'annulation (supprimé s'il a moins de 48 h, sinon désépinglé). Le sondage est supprimé s'il a moins de 48 h, sinon désépinglé.
9. **Annulation manuelle du sondage** : refusée avec un 409 dès qu'un événement `collect_votes` réussi existe pour le job, y compris pour les jobs legacy (`pollClosedAt` reste refusé aussi).
10. **Confirmation et rappel** affichent les inscrits du roster courant (« Inscrits : »), sans liste d'attente ni mentions « (remplace … ) ».
11. **Mode legacy inchangé** : un job collecté avant le déploiement (pas de base de roster) ou dont le sondage a été envoyé avec la mention « réponses jusqu'au » garde ADR-037 de bout en bout (sondage clôturé, récap, annonce classique).

## Alternatives écartées

- **Relire `get_responses` à chaque vote** : renvoie « aucune_reponse » pour tous, sans erreur, si huddle-bot a redémarré (ADR-037, point 4bis) ; un roster basé dessus pourrait se vider en silence. La photo de collecte garde le `votedAt` de chaque votant et les événements du listener font le reste.
- **Édition du message en place** : une édition n'est visible que ~15 min sur WhatsApp. On reposte donc le roster en bas du groupe et on retire l'ancien (modèle repris de footEntrePotes-assistant, ADR-0009).
- **Republication quotidienne (ou à chaque tick)** : bruit pour le groupe sans changement réel. L'empreinte du texte ne déclenche une republication que quand l'affichage change.

## Conséquences

- Migration `0034_roster_vivant.sql` : colonnes `roster_*` (photo, identités, base du plan, définitif, message publié, empreinte, épinglage, orphelin, claim, arrêt) et `poll_unpinned_at` sur `job_runs`. Appliquée par l'initContainer ([ADR-012](./ADR-012-migrations-automatiques-initcontainer.md)).
- **Épinglage (C3-1, PC3-5).** Au plus 2 messages épinglés par règle : le sondage et le roster, qui peut être l'orphelin. Après un échec de retrait, l'orphelin reste épinglé avec le sondage et aucun autre roster n'est épinglé tant qu'il est mémorisé. La limite WhatsApp de 3 vaut par groupe ; elle reste protégée par la règle « une seule règle active par groupe ». Limite acceptée : au sondage suivant, le roster du job précédent est seulement désépinglé. S'il est republié ensuite (par exemple après un vote avant son premier créneau), il est réépinglé par les règles normales. On reste à 2 épinglés au plus par règle.
- **huddle-bot redémarré** : s'il perd les clés du sondage, il ne déchiffre plus les votes, plus d'événement, et le roster se fige. Même risque qu'aujourd'hui pour la collecte ; aucune parade dans ce périmètre.
- **Listener arrêté** : les événements arrivent en retard par redelivery JetStream et sont appliqués à leur arrivée. L'ordre « premier arrivé » est celui de l'arrivée en base, pas celui du vote : un roster publié n'est jamais réécrit rétroactivement.
- **Règle désactivée en cours de semaine** : le listener ne persiste que les votes des groupes des règles actives ; le roster se fige. Limite acceptée.
- **Groupe du sondage** : le filtre des événements utilise le groupe où le sondage a réellement été envoyé (copie de la règle prise par le job).
- **Votant `@lid`** : un événement sans téléphone est rapproché de la photo par nom WhatsApp ; sans correspondance, il est compté sous son JID avec un Telegram nommant le votant.
- **Pas de Telegram par remplacement** : seuls les échecs et les anomalies de vote vont sur Telegram.
- Limites ouvertes, non tranchées :
  - un votant tardif non identifié n'est signalé que dans les logs, sans Telegram (décision à prendre par Vinz) ;
  - la vérification sur les données réelles (`docs/plan/verif-roster-votes.sql` : `pollWhatsappMessageId` égal à `poll_msg_id`, `actor.phone` renseigné pour un vote `@lid`) reste à exécuter avant le déploiement.
