# Clôture du sondage à la collecte + récap des inscrits — design

Date : 2026-10-09
Statut : proposé (en attente de relecture utilisateur)

## Contexte

Job `04578758` (« squash-samedi-matin v2 », samedi 2026-10-10) :

- La collecte des votes et le calcul du plan sont partis ensemble à `decisionTime` (lundi 05/10 9h00 Paris). Henry (vote 10H30 le 07/10) et Stef (prête-nom le 06/10) ont répondu **après** : votes jamais pris en compte, sans que personne ne le sache. Le sondage restait votable dans WhatsApp.
- Thomas LECCIA et Vince avaient répondu « Non, mais je peux prêter mon nom » mais leur téléphone n'est associé à aucun compte resa-squash : rangés dans `unresolvedNames`, ils n'apparaissaient sur Telegram que noyés dans le message « Confirmés par heure ». Résultat : « Prête-noms volontaires : (aucun) ».
- Le groupe Vincent+Hugo demandait 3 rounds (minSlots=3) avec un plafond de 2 résas/jour : le planificateur a réessayé chaque créneau de 12H00 à 18H00 (`continue`), un warning par créneau, d'où la synthèse illisible.
- L'annonce WhatsApp disait « 1 joueur(s) n'ont pas pu être réservé(s) » alors que les 4 joueurs jouaient (`computeShortfall` compte des rounds, pas des joueurs).

## Principe transverse : WhatsApp ≠ Telegram

- **WhatsApp** = les joueurs. Messages concis, sans détail technique, sans ⚠️ qui ne les concerne pas.
- **Telegram** = l'organisateur / développeur (debug). Détails techniques bienvenus : téléphones, causes, ids.

Tout message défini ci-dessous respecte cette séparation.

## 1. Clôture du sondage

### 1.1 Date de clôture dans le sondage

`buildPollQuestion` ajoute la clôture à la question :

> Squash samedi 10 octobre à 10h30 ? (réponses jusqu'au lundi 5 oct. à 9h00)

- Calculée depuis la date cible, `decisionDaysBefore` et `decisionTime` du snapshot de la règle, en **heure de Paris** (jamais l'UTC stocké en base).
- `decisionDaysBefore = 0` (décision le jour du match) : même format, le jour affiché est le jour du match.
- Combinaison avec la mention « puc fermé » existante : la clôture vient en dernier.
- Job manuel : même texte (l'heure affichée est celle à laquelle la décision auto partirait ; une collecte manuelle plus tôt ferme plus tôt, c'est assumé).

### 1.2 Fermeture à la collecte (étape 2)

Dans le nœud `CollectVotes`, auto ou manuel, dans cet ordre :

1. Lecture des votes (`resolveVotes`). **Si elle échoue, rien n'est supprimé** (l'étape échoue comme aujourd'hui, les votes restent dans WhatsApp).
2. Désépinglage du sondage si `pinMessagesEnabled` (existant).
3. Suppression du sondage : `delete_message` sur `whatsappGroupJid` / `job.pollMsgId`. Best-effort : un échec est signalé sur Telegram (`[règle] Suppression du sondage échouée : …`) et le pipeline continue.
4. Envoi du récap des inscrits (§2).
5. Message Telegram « votants non identifiés » si besoin (§3).

Pourquoi la suppression : WhatsApp n'offre pas de fermeture native d'un sondage. Le groupe verra « message supprimé » à la place, et le récap épinglé prend le relais.

### 1.3 Retrait de « Relire les réponses »

Le sondage n'existant plus après la collecte, la relecture n'a plus d'objet. Sont supprimés : le bouton dans `Pipeline.tsx`, l'action UI `recollect-votes`, la route worker et `triggerRecollectVotes` (scheduler). `cancelPollAction` (annulation tant qu'aucun vote n'est collecté) est inchangé.

### 1.4 Épinglage du sondage (vérification demandée)

Comportement existant, conservé : épinglé à l'envoi (étape 1, si `pinMessagesEnabled`), désépinglé à la collecte (étape 2). En auto, la collecte et le plan partent ensemble à `decisionTime`, donc le sondage est épinglé de l'étape 1 jusqu'au début de l'étape 3, puis supprimé.

## 2. Récap des inscrits (WhatsApp)

### 2.1 Contenu

```
📋 Inscriptions closes — samedi 10 octobre
10H30 (4) : Hugo MERCIER, Vincent LACOSTE, Gaëtan COATANROCH, Martin MERLOT
Merci à Thomas LECCIA et Vince pour les prête-noms :)
```

- Une ligne par heure candidate ayant au moins un inscrit, au format `HEURE (n) : noms`.
- Ligne prête-noms seulement s'il y a des volontaires, **identifiés ou non** : on remercie tout le monde, sans ⚠️. Un seul volontaire : « Merci à X pour le prête-nom :) ».
- Noms : `list_group_members` resa-squash (best-effort, comme la synthèse). Un votant non identifié apparaît avec son nom WhatsApp (`displayName`), sans marque particulière.
- Aucun inscrit : « 📋 Inscriptions closes — samedi 10 octobre\nAucun inscrit cette semaine. »
- Envoyé aussi en dry-run (comme l'annonce).

### 2.2 Destinataire

Groupe de l'annonce (`reservationNotifyWhatsappGroupJid`, repli sur `whatsappGroupJid`), comme l'annonce. Aucun nouveau réglage.

### 2.3 Épinglage

- Si `pinMessagesEnabled` : épinglé (`pinBestEffort`). Durée WhatsApp : `7d` si le match est à ≤ 7 jours de la décision, sinon `30d` (filet seulement).
- `msgId` et groupe mémorisés sur le job : nouvelles colonnes `job_runs.recap_msg_id` / `job_runs.recap_jid` (migration 0033, nullable).
- Désépinglage, le premier qui arrive :
  1. **Jour du match** : le tick global du rappel (ADR-036, `* * * * *`) désépingle le récap à l'heure du premier créneau réservé (heure de Paris), puis remet `recap_msg_id` à null. Aucun créneau réservé : à 23h59 le jour du match.
  2. **Sondage suivant** de la même règle : désépinglé comme l'annonce précédente (`unpinPreviousAnnounce` élargi), indépendamment de la case.
- Indépendant de `startReminderEnabled` : le désépinglage du récap tourne même si le rappel est désactivé.
- Job annulé (fermeture du club, annulation manuelle) après l'envoi du récap : le désépinglage suit la même logique (jour du match ou sondage suivant).

## 3. Telegram : votants non identifiés

### 3.1 Message dédié

Envoyé à la collecte dès qu'au moins un votant (heure **ou** prête-nom) n'a pas de numéro connu de resa-squash :

```
[squash-samedi-matin v2] ⚠️ 2 votant(s) sans numéro dans resa-squash — impossible de savoir qui c'est, exclu(s) du plan :
  • Vince (+33663892186) — « Non, mais je peux prêter mon nom »
  • Thomas LECCIA (+33686870364) — « Non, mais je peux prêter mon nom »
→ Associer ce numéro à leur compte TeamR/resa-squash.
```

Le suffixe « non résolu(s) » du message « Confirmés par heure » est retiré (doublon).

### 3.2 Changement de `resolveVotes`

`unresolvedNames: string[]` devient `unresolvedVoters: Array<{ name: string; phone: string | null; option: string }>`. Les consommateurs (state, détail d'événement `collect_votes`, synthèse) sont adaptés. Votant sans téléphone du tout : `phone: null`, affiché « (pas de numéro WhatsApp) ».

### 3.3 Synthèse du groupe test

La synthèse (groupe test uniquement) liste les volontaires non identifiés par leur nom WhatsApp avec « ⚠️ non identifié » au lieu de « (aucun) ». C'est un message de debug sur un groupe test, le ⚠️ y est permis.

## 4. Correctifs du même lot

### 4.1 Planificateur : arrêt au plafond (`scheduleGroupTimeline.ts`)

Quand un joueur est bloqué par le plafond de résas/jour et que ni prête-nom ni joker ne règle la paire, la recherche des rounds restants du groupe **s'arrête** (`break`) : le plafond ne se débloque pas plus tard dans la journée. Un seul warning :

> Vincent LACOSTE, Hugo MERCIER : 3e round demandé mais plafond 2 résas/jour atteint — aucun prête-nom disponible et joker déjà mobilisé.

Le warning final « n/N round(s) réservé(s) — créneaux insuffisants » n'est plus émis dans ce cas (la cause est le plafond, pas les créneaux). Le cas « joueur non réinscrit » garde `continue` : la paire suivante du cycle (groupe de 3) peut être différente.

### 4.2 Compteur de l'annonce (`announce.ts`)

« ⚠️ N joueur(s) n'ont pas pu être réservé(s) cette semaine » compte des **joueurs confirmés sans aucun créneau réservé** : joueurs hors de tout groupe (surplus au-delà du plafond par court) et membres d'un groupe dont aucune réservation n'a abouti (hors fenêtre ou échec de réservation). Un round manquant d'un groupe qui joue n'est plus compté. Le planificateur expose les membres par groupe dans `plan.meta` pour ce calcul. Ligne omise si N = 0.

## 5. Documentation

- `docs/spec/regles-fonctionnelles.md` :
  - §3 : clôture à la collecte, suppression du sondage, retrait de « Relire les réponses », récap, message Telegram ;
  - section épinglage : récap des inscrits ;
  - synthèse du groupe test ;
  - principe WhatsApp ≠ Telegram ;
  - historique des décisions.
- ADR-037 : clôture du sondage par suppression du message WhatsApp à la collecte.

## 6. Tests

- `buildPollQuestion` : clôture en heure de Paris (été et hiver), `decisionDaysBefore = 0`, combinaison avec « puc fermé ».
- `resolveVotes` : `unresolvedVoters` avec téléphone et option, votant sans téléphone.
- Nœud `CollectVotes` (huddle-bot simulé) : ordre lecture → désépinglage → suppression → récap ; aucune suppression si la lecture échoue ; échec de suppression signalé sur Telegram sans faire échouer l'étape.
- Message du récap : plusieurs heures, aucun inscrit, 1 et plusieurs prête-noms, volontaire non identifié remercié par son nom WhatsApp.
- Tick : désépinglage du récap à l'heure du premier créneau, à 23h59 sans créneau, pas de double désépinglage.
- `scheduleGroupTimeline` : plafond → un seul warning et arrêt ; non-réinscrit → comportement inchangé.
- Compteur de l'annonce : cas du job 04578758 → 0 ; groupe sans aucune réservation → ses membres comptés.

## Hors périmètre

- Pas de fermeture différée ni de relecture après clôture.
- Pas de nouveau réglage de groupe pour le récap.
- Le message d'annulation pour fermeture du club reste sur le groupe d'origine.
- Pas de rattrapage des joueurs non identifiés (l'association téléphone ↔ compte se fait à la main dans TeamR/resa-squash).
