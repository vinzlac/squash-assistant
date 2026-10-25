# Design — Sondage conservé et roster vivant (désistements, remplacements, liste d'attente)

**Date** : 2026-10-24
**Besoin** : [`docs/besoins/2026-10-24-roster-desistements.md`](../../besoins/2026-10-24-roster-desistements.md) (verdict : construire)
**Revient sur** : [ADR-037](../../adr/ADR-037-cloture-sondage-suppression-collecte.md) (suppression du sondage à la collecte) — nouvel ADR-038 à écrire.
**Modèle repris** : footEntrePotes-assistant ADR-0006 (réouverture temps réel) et ADR-0009 (message vivant reposté en bas, l'ancien supprimé).

## 1. Intention

Aujourd'hui, le sondage disparaît à la collecte et le groupe reçoit un récap figé « 🔒 Inscriptions closes ». Ensuite, toute la vie de la session se fait par messages texte : les désistements, les « on est combien ? », et Vinz qui coordonne à la main qui prend la place de qui. Le 2026-10-24, Laurent est même venu sans s'inscrire, faute de sondage. Ça arrive au moins 2 fois par mois.

Le but est de prolonger le pipeline jusqu'au jour J :
- le sondage reste le **seul canal d'inscription et de désistement**, toujours votable ;
- le groupe voit en permanence un **roster à jour** : qui joue à quelle heure, combien de places restent, qui attend, qui remplace qui.

Le gain est surtout la clarté pour le groupe. Le temps gagné par Vinz est secondaire.

## 2. Objectifs, non-objectifs, anti-objectifs

**Objectifs**
- Le sondage n'est plus supprimé. Il reste votable jusqu'au début du premier créneau réservé.
- Entre la collecte et la réservation, un **roster provisoire** (liste des « oui », sans plafond) remplace le récap « 🔒 Inscriptions closes ».
- Les votes arrivés entre la collecte et le calcul du plan entrent dans le plan.
- Après la réservation, le **roster définitif** remplace l'annonce des courts. Il contient :
  - les créneaux, adjacents regroupés ;
  - les inscrits par heure ;
  - les places libres ;
  - la liste d'attente ;
  - les remplacements ;
  - le rappel de la règle de désistement.
- Le roster est republié, en bas du groupe, à chaque changement de vote.

**Non-objectifs** (hors périmètre du besoin)
- Toucher aux réservations TeamR, que ce soit pour annuler, modifier ou changer un participant. Les créneaux restent au nom des joueurs d'origine.
- Interpréter les messages texte. Seul le sondage fait foi.
- Renommer le sondage (impossible sur WhatsApp).
- Tout suivi après le début du premier créneau.
- Telegram pour chaque remplacement ou entrée en liste d'attente. Vinz a tranché le 2026-10-24 : seuls les échecs vont sur Telegram.

**Anti-objectifs** (échecs même si « ça marche »)
- Un roster qui montre quelqu'un comme inscrit alors qu'il a retiré son vote, ou l'inverse.
- Un groupe qui reçoit un roster à chaque tick sans qu'aucun vote n'ait changé.
- Deux rosters vivants visibles en même temps, quand la suppression de l'ancien était possible.
- Une réservation déclenchée ou modifiée par un vote. Le « go » reste la seule porte d'écriture (§7 des règles fonctionnelles).

## 3. Contraintes

- **WhatsApp**
  - Un sondage envoyé ne peut pas être modifié.
  - Une édition de message n'est visible que pendant environ 15 min. On n'édite donc jamais le roster : on le reposte.
  - La suppression « pour tous » n'est possible que pendant 48 à 60 h environ. Le seuil retenu est `POLL_DELETE_MAX_AGE_HOURS = 48`, réutilisé.
  - Au plus 3 messages épinglés par groupe.
- **`get_responses` (huddle-bot)**
  - Il renvoie, pour chaque membre, `votedAt` (epoch ms du dernier vote, null si inconnu ; huddle-bot `apps/listener/src/poll-requests.ts`, description du tool MCP). Le type local `PollResponses` (`apps/worker/src/mcp/huddleBot.ts`) ignore ce champ aujourd'hui : à ajouter.
  - Il renvoie « aucune_reponse » pour tous, sans erreur, si huddle-bot a redémarré (ADR-037, point 4bis).
  - On ne le rappelle donc **pas** à chaque vote. La photo de collecte garde le `votedAt` de chaque votant.
- **Événements de vote** : le listener persiste déjà chaque `poll_vote_creation` / `poll_vote_update` / `poll_vote_deletion` dans `whatsapp_resa_events`, pour tous les groupes des règles actives. Chaque événement contient :
  - `occurredAt` ;
  - `actor.phone` ;
  - `data.pollWhatsappMessageId` ;
  - `data.selectedOptions`, l'état complet du vote de ce membre après l'événement.
- **Un seul choix par votant.** `get_responses` renvoie un statut par membre. Un joueur est donc à une seule heure, ou « Non », ou prête-nom.
- **Invariants projet**
  - WhatsApp ≠ Telegram (§7) ;
  - noms en pseudo, jamais d'id ni de téléphone sur WhatsApp (`playerMessageName`, `publicVoterName`) ;
  - best-effort pour tout ce qui suit l'envoi ;
  - migration appliquée par l'initContainer (ADR-012).

## 4. Comportement décidé

### 4.1 Sondage conservé (amende ADR-037)

- La collecte **ne supprime plus** le sondage et n'écrit plus `poll_closed_at`. Le chemin de suppression (`closePoll`) n'est plus appelé, sauf pour les jobs qui gardent l'ancien comportement (§4.7, « Jobs déjà en cours au déploiement »). Pour ces jobs, la collecte n'écrit pas de base de roster (C1-3).
  - Un job déjà clôturé avant le déploiement (`poll_closed_at` renseigné) garde le comportement de relance actuel, qui reprend les votes de `collect_votes`.
- La question du sondage **ne mentionne plus** « (réponses jusqu'au … ) ». Même chose dans l'aperçu UI (`buildPollQuestionPreview`).
- La lecture vide suspecte (ADR-037, point 4bis) reste inchangée : l'étape échoue avant toute action.
- **Épinglage** (si `pinMessagesEnabled`) :
  - le sondage **reste épinglé** à la collecte ;
  - il est désépinglé, comme le roster, au début du premier créneau réservé (tick existant `triggerRecapUnpins`, étendu au sondage) ;
  - même règle que le récap actuel pour une annulation ou un job sans créneau.
  - Une règle utilise au plus 2 épinglages (sondage + roster), sauf après un échec de retrait (§4.7) : l'annonce n'est plus épinglée séparément, puisque le roster la remplace.
- **Fermeture PUC déclarée après la collecte** (décision de Vinz du 2026-10-24, R2-2 ; `apps/worker/src/closures/cancelJobForClosure.ts`) :
  - le sondage est **supprimé s'il a moins de 48 h**. Sinon il est **désépinglé**, et le message de fermeture prend la variante existante « Ignorez le sondage du coup » ;
  - la suppression vise le groupe où le sondage a été envoyé ;
  - le roster, provisoire ou définitif, est retiré selon la règle du §4.7 : supprimé s'il a moins de 48 h, sinon désépinglé ;
  - le job annulé ne publie plus.
- L'annulation manuelle du sondage reste possible tant qu'aucun vote n'est collecté. Le garde-fou côté worker (`apps/worker/src/http/server.ts`, refus si `pollClosedAt`) ne tient plus, puisque `poll_closed_at` n'est plus écrit. Il devient : **refus si un événement `collect_votes` réussi existe pour le job** (ou `pollClosedAt`, pour les anciens jobs). Test dédié ; règle §3 amendée.

### 4.2 État vivant des votes : photo de collecte + événements

L'état des votes d'un job s'écrit ainsi :

```
votes = photo de la collecte  ⊕  événements de vote du sondage, appliqués dans l'ordre d'arrivée en base
```

Décision du 2026-10-24 (R1-2) :
- L'ordre de traitement est l'**ordre d'arrivée en base** : `created_at`, puis `event_id`. Ce n'est pas `occurredAt` (horloge du téléphone du votant, retards de redelivery). Un événement arrivé en retard est donc appliqué au moment où il arrive, jamais à sa place chronologique. Un roster publié n'est jamais réécrit rétroactivement, et aucun événement n'est perdu.
- **Événement périmé** : un événement dont `occurredAt` n'est pas postérieur au dernier vote déjà connu de ce votant est ignoré. Le dernier vote connu est le `votedAt` de la photo, ou le `occurredAt` du dernier événement appliqué. C'est aussi ce qui règle le cas d'un vote compté à la fois dans la photo et dans un événement autour de la collecte.
- **Ensemble intégré** : chaque base (photo, base du roster définitif §4.5) mémorise les `event_id` déjà pris en compte. Tout événement du sondage absent de cet ensemble est appliqué ensuite, quelle que soit sa date.

- **Photo** : ce que `resolveVotes` lit à la collecte, déjà enregistré dans l'événement `collect_votes`. Elle est complétée, pour chaque votant, par son **téléphone normalisé** et son **`votedAt`**, et par les `event_id` du sondage déjà en base à la lecture. **Ordre de capture** (R2-1) : les `event_id` sont lus **avant** `get_responses`. huddle-bot met son décompte à jour avant de publier l'événement : tout événement de l'ensemble est donc reflété dans la photo, et un vote arrivé entre les deux lectures n'est jamais perdu (au pire appliqué deux fois, sans effet grâce à la règle de l'événement périmé).
- **Événements retenus** : lignes de `whatsapp_resa_events` dont :
  - le `chat_jid` est le groupe du sondage ;
  - `payload.data.pollWhatsappMessageId` est égal à `job_runs.poll_msg_id` ;
  - le type est `poll_vote_*`.

- **Application d'un événement** : l'événement donne l'état complet du vote du membre (`selectedOptions`). On l'applique comme « ce membre est maintenant à X ». Rejouer la même liste dans le même ordre donne toujours le même résultat. `selectedOptions` vide (retrait) ou « Non » veut dire « ne joue pas ».
- **Identité d'un votant** (décision R1-3) : la clé de rapprochement est le **téléphone normalisé** (E.164 avec « + » ; `get_responses` le donne sans « + », le listener l'ajoute). Elle ne dépend jamais d'un appel à resa-squash.
  - À défaut de téléphone : le JID WhatsApp pour un événement. Dans la photo, un votant sans téléphone est associé par nom.
  - **Votant masqué `@lid`** (décision de Vinz du 2026-10-24, R2-4). La photo a son téléphone, mais son événement pourrait n'avoir que le JID `@lid` (huddle-bot `buildActor`). Il compterait alors deux fois. Donc :
    1. **première tâche du plan** : vérifier, sur des événements réels de `whatsapp_resa_events`, que `actor.phone` est toujours renseigné pour un vote `@lid` ;
    2. si ce n'est pas le cas, un événement sans téléphone est rapproché de la photo par **nom WhatsApp** (`actor.displayName` = nom du membre dans la photo). Limite acceptée : deux membres de même nom restent ambigus.
    3. un événement sans téléphone et sans nom correspondant dans la photo (décision de Vinz du 2026-10-25, C1-4) est **compté sous son JID**, comme un votant nouveau, et un Telegram le nomme (nom WhatsApp, JID) pour que l'organisateur vérifie un éventuel double compte. La vérification de la tâche 1 compare aussi les noms de la photo et ceux des événements sur des votes réels.
  - Le `userId` resa-squash et le pseudo ne servent qu'au plan et à l'affichage. Ils sont repris de la photo (`voterNames`) et mémorisés avec le roster. `lookup_player_by_phone` n'est appelé que pour un votant **nouveau** (absent de la photo et des noms mémorisés). En cas d'échec, le votant est affiché avec son nom WhatsApp (`publicVoterName`) et compté comme non identifié dans le plan. La recherche n'est retentée qu'au prochain calcul de plan (« Recalculer le plan »), jamais à chaque tick (R2-7).
  - Un votant non identifié compte comme les autres dans le roster (affiché par `publicVoterName`). Il reste hors plan, comme aujourd'hui.
- Les votes « prête-nom volontaire » mettent à jour `volunteerSubstituteIds` pour le plan. Ils ne sont jamais inscrits ni en attente à une heure. Seul le roster provisoire les remercie (ligne 🙏, comme le récap actuel) ; le roster définitif ne les cite pas.
- **À vérifier en tout premier dans le plan** : `data.pollWhatsappMessageId` des événements est-il égal au `msgId` renvoyé par `ask_poll` (`job_runs.poll_msg_id`), au même format ? Sinon, le rattachement se fait autrement (`pollName` = question enregistrée dans l'événement `poll`, groupe, fenêtre de dates). Si aucun rattachement fiable n'est possible, **arrêt et question à Vinz**.

### 4.3 Le plan prend les votes tardifs (CA-2)

- Avant chaque calcul de plan (« Calculer le plan », décision auto, « Recalculer le plan »), les votes du job sont recalculés par §4.2 avec tous les événements en base à cet instant. `confirmedPlayerIdsByTime`, `volunteerSubstituteIds`, `unresolvedVoters` et `voterNames` sont mis à jour dans l'état.
- **Ordre** (R1-4), pour « Recalculer le plan » :
  1. recalcul des votes (§4.2) ;
  2. nouvelle recherche des non-identifiés (`relookupUnresolvedVoters`, inchangée, avec son Telegram) ;
  3. plan.

  Pour « Calculer le plan » et la décision auto, l'étape 2 n'existe pas. Le concepteur choisit l'endroit, mais un joueur identifié à l'étape 2 ne doit jamais être écrasé par l'étape 1. Test dédié.
- L'**instant du calcul** (`T_plan`), l'état des votes utilisé et l'ensemble des `event_id` intégrés sont mémorisés **en base** avec le plan. Ils forment la **base du roster définitif** (§4.5).
- Un vote arrivé après `T_plan` (pendant l'attente du « go ») ne change pas le plan. Il est appliqué au roster après la réservation : place libre ou liste d'attente. Pour le prendre dans le plan, il faut « Recalculer le plan » avant le go. Rien n'est recalculé tout seul.

### 4.4 Roster provisoire (CA-1)

- À la collecte, il est envoyé à la place du récap, sur le **groupe de l'annonce** (règle live, mode test compris, comme le récap).
- Il est republié à chaque changement de vote, de la collecte jusqu'à la publication du roster définitif.
- Le format reprend le récap actuel, variante sans clôture :

```
📋 Inscrits — samedi 24 octobre 🎾
⏰ 9h (4) : Henry, Stef, Vinz, Laurent
⏰ 10h30 (2) : Hugo2, Terence
🙏 Merci à X pour le prête-nom :)
Les courts arrivent bientôt 😉
Pour te désister, retire ton vote dans le sondage 🙏
```

- **Pas de plafond.** Choix de Vinz du 2026-10-24 : le plafond n'existe qu'une fois les courts réservés. Une heure sans inscrit n'est pas affichée. Sans aucun inscrit : `📋 Inscrits — <date>` puis `Personne pour l'instant 😢`.
- Le titre « 🔒 Inscriptions closes » disparaît.

### 4.5 Roster définitif (CA-3)

Il est envoyé par l'étape 4 **à la place de l'annonce**, réel ou dry-run, sur le groupe de l'annonce. Les QR (réel) et la synthèse du groupe test continuent de suivre, inchangés.

- **Base**
  - heures du roster = heures candidates qui ont au moins un « oui » dans l'état de `T_plan` ;
  - **plafond(h)** = nombre de « oui » à h dans cet état, identifiés et non identifiés (« plafond égal au nombre de oui retenus à la réservation ») ;
  - **inscrits(h)** au départ = ces votants ;
  - liste d'attente vide.
- **Heure sans court** (décision de Vinz du 2026-10-24, R1-5) : une heure candidate dont le plan n'a **aucun créneau réellement pris** (refusé, hors fenêtre, joueur déplacé vers une autre heure, effectif insuffisant) a un **plafond 0**. Ses votants commencent en attente et la ligne s'affiche `⏰ 9h : pas de court réservé`. La marge « joueurs imprévus » n'est pas comptée dans le plafond.
- Les événements de vote absents de l'ensemble intégré à T_plan sont ensuite appliqués selon §4.6, dans l'ordre d'arrivée en base.
- **Format** :

```
🏸 Réservations confirmées
📅 2026-10-24

Court 2 : 09H00-10H30
Court 3 : 10H30-12H00

⏰ 9h (4/4) : Hugo2 (remplace Henry), Stef, Vinz, Laurent
⏳ En attente 9h : Terence
⏰ 10h30 (1/2) : Max — 1 place libre
⚠️ Non réservé : … (inchangé, ADR-027)
⚠️ N joueur(s) n'ont pas pu être réservé(s) cette semaine. (inchangé)

Pour te désister, retire ton vote dans le sondage 🙏
```

  - Cet exemple est un scénario distinct de celui du roster provisoire du §4.4. Ici, à T_plan : 4 « oui » à 9 h (Henry, Stef, Vinz, Laurent) et 2 à 10 h 30 (Max, Paul). Ensuite, dans l'ordre :
    1. Paul retire son vote : 1 place libre à 10 h 30 ;
    2. Hugo2 et Terence votent 9 h et partent en attente ;
    3. Henry se retire : Hugo2 le remplace.
  - Le titre et le bloc des courts sont ceux de l'annonce actuelle (`buildAnnounceTitle`, `formatMergedCourtSlots`, créneaux réellement pris seulement).
  - « — k place(s) libre(s) » n'apparaît que si k > 0. La ligne « ⏳ En attente » n'apparaît que si elle n'est pas vide.
  - Une heure à plafond 0 avec des votants en attente s'affiche `⏰ 11h15 : pas de court réservé`, puis sa ligne d'attente.
  - Autres rendus (R2-10) :
    - heure à plafond > 0 tombée à 0 inscrit : `⏰ 9h (0/4) — 4 places libres` ;
    - heure votée seulement après le calcul du plan : plafond 0, rendue `⏰ <heure> : pas de court réservé` puis sa ligne d'attente (C1-7) ;
    - heure à plafond 0 dont l'attente est vide : non affichée.
  - Dans une heure, les noms suivent l'ordre d'arrivée (R2-8) : d'abord les inscrits de la base dans l'ordre de leur `votedAt` (un `votedAt` nul passe après les autres ; égalité départagée par téléphone normalisé, puis par pseudo affiché, C1-6), puis chaque entrée dans l'ordre d'application. Un remplaçant prend le rang de celui qu'il remplace.
  - Le pied comporte aussi la ligne (décision R1-18) : `Changer d'heure = repasser en attente si l'heure est pleine.`
- **Dry-run** (décision de Vinz du 2026-10-24, R1-6) : le roster définitif dry-run est publié **et republié** comme en réel, y compris sur le groupe du sondage. Son titre est celui de l'annonce dry-run. Les « créneaux pris » sont ceux du plan annoncé.
- Échec total de réservation : le message d'échec actuel reste. Pas de roster définitif. Le job passe en `error` (`announce.ts`, inchangé) : il ne publie pas, et son roster provisoire est retiré comme pour une fin sans réservation (§4.7). **Amendé le 2026-10-25 (décision de Vinz, B1-7)** : le provisoire n'est plus retiré pour un `error` sans `rosterFinal` ; il reste en place et n'est retiré qu'une fois la date du match passée (§4.7).
- **Échec d'envoi du roster définitif après la réservation (2026-10-25, décision de Vinz, B1-8)** : l'étape ne lève pas. La base (`rosterFinal`) est déjà enregistrée ; un Telegram prévient l'organisateur (« Roster définitif non envoyé (…) : <cause> — nouvel essai par le tick chaque minute », un seul, envoyé par la publication, B2-5) et l'étape continue : QR, synthèse du groupe test, Telegram d'annonce (« (roster non envoyé, nouvel essai par le tick) »), fin `finished-announced` ; l'événement `announced` porte `rosterSent: false`. Le tick republie le définitif. L'échec total de réservation, lui, lève toujours.
- Le roster définitif **remplace le provisoire** selon l'ordre du §4.7 : le provisoire est supprimé s'il a moins de 48 h, sinon désépinglé.
- Le roster définitif vaut « annonce » pour l'UI (`announceMessage`, étape 4) et l'événement `booking`.

### 4.6 Règles d'attribution (CA-4 à CA-8, CA-11)

Les événements postérieurs à `T_plan` sont traités dans l'ordre. Pour un votant v dont le nouveau choix est o :

1. **Si v est déjà inscrit ou en attente à une heure h différente de o**, il en est retiré.
   - S'il était **inscrit** et que l'attente de h n'est pas vide, le **premier en attente** devient inscrit avec la mention « (remplace v) » (CA-5).
   - S'il était inscrit et que l'attente est vide, la place devient **libre**. Elle garde en mémoire qui l'a libérée (v).
2. **Si o est une heure h'** :
   - s'il reste une place libre (`|inscrits| < plafond`), v devient inscrit. S'il prend une place libérée, il porte « (remplace <qui l'a libérée> ) » (CA-6, premier arrivé). Choix de la place (R2-5) : il reprend d'abord celle qu'il a lui-même libérée si elle est encore libre, sans mention ; sinon la place libérée **la plus ancienne**, ce qui fixe le nom affiché ;
   - sinon, v va en **fin** de liste d'attente de h' (CA-4, CA-7 : l'attente est par heure, une place libre à 9 h ne sert pas à 10 h 30) ;
   - un joueur qui revote après s'être désisté suit la même règle et repasse en fin d'attente si sa place a été prise (CA-8).
3. **Un choix identique à l'état actuel** du votant ne change rien.
4. **Seuls les votes du sondage comptent.** Un message texte ne change jamais le roster (CA-11). C'est naturel, puisque seuls les événements `poll_vote_*` sont lus.

Choix du concepteur :
- La mention « (remplace X) » désigne le **prédécesseur immédiat**, pas le titulaire TeamR d'origine.
- Elle reste affichée tant que le remplaçant est inscrit.

### 4.7 Publication (CA-9, CA-10)

- **Déclencheur** : le tick à la minute existant (ADR-036, `runMinuteTick`). Le roster est donc à jour une minute au plus après un vote. Plusieurs votes dans la même minute donnent une seule republication.
- **Jobs concernés** :
  - collecte faite ;
  - non annulé ;
  - date du match non passée ;
  - avant le début du premier créneau réellement réservé (heure de Paris) ;
  - phase provisoire : avant l'annonce ;
  - phase définitive : `finished-announced` avec au moins un créneau réservé.

  Un job terminé sans réservation (pas de go, pas de plan, échec total) ne publie plus rien. Son roster provisoire est retiré (décision R1-16) : supprimé s'il a moins de 48 h, sinon désépinglé.

  **Jobs déjà en cours au déploiement** (décision R1-7) : un job dont la collecte a eu lieu avant le déploiement garde l'ancien comportement de bout en bout (sondage clôturé, récap, annonce classique). Il n'a pas de roster. Le marqueur est l'absence de base de roster en base, renseignée à la collecte.

  Un sondage **envoyé** avant le déploiement mais collecté après (sa question contient « réponses jusqu'au », `pollAnnouncedClosure`) garde aussi l'ancien comportement (R2-12) : sa question annonce une clôture, qui doit avoir lieu. Le mode test suit le nouveau comportement : le sondage n'est plus désépinglé à la collecte.

  Précisions :
  - seul le **job actif** de la règle pour la date compte (même sélection que le rappel avant match) ;
  - **amendé le 2026-10-25 (B1-13 ; décision de Vinz pour B2-1)** : un job qui n'est plus le job actif de sa date (« Nouveau job » sur la même date) ne fait rien tant que le nouveau job actif n'a pas envoyé son sondage (roster figé, ni publication ni arrêt ; il repart si le nouveau job disparaît ou change de date) ; ensuite son roster est retiré une seule fois puis arrêté, sauf un roster définitif avec au moins un court réservé, jamais supprimé, seulement désépinglé (B1-13 a amendé par B2-1). Un job dont la date est passée sans réservation voit son roster retiré puis arrêté, au lieu de rester épinglé jusqu'à 7 jours (B1-13 b). Un job annoncé avec un roster définitif dont le premier créneau est illisible s'arrête à 23h59 (B1-13 c).
  - un job en `error` ne publie pas ; **amendé le 2026-10-25** (Ruling de T10, ADR-038 §8) : un job en `error` qui a un `rosterFinal` (courts réellement pris) republie son roster définitif jusqu'au premier créneau ; un job en `error` sans `rosterFinal` voit son roster provisoire retiré ; **amendé le 2026-10-25 (décision de Vinz, B1-7)** : un job en `error` sans `rosterFinal` ne fait rien (ni retrait ni publication), le provisoire reste en place jusqu'à « Relancer » ou jusqu'au retrait une fois la date passée ;
  - un job `finished-cancelled` ou `finished-no-plan` remis en `awaiting-go` par « Recalculer le plan » reprend la phase provisoire ;
  - la condition de fin (premier créneau réservé) peut lire le checkpoint, comme `firstReservedSlotOfJob` le fait déjà. La base du roster (§5), elle, est en base de données.
- **Republier seulement si le texte change** : on compare une empreinte du texte du roster à celle du dernier roster publié. Le changement d'un votant qui ne modifie rien à l'affichage ne produit aucun message.
- **Ordre de republication** (ADR-0009 footEntrePotes) :
  1. envoyer le nouveau roster ;
  2. mémoriser son `msgId` ;
  3. retirer l'ancien. On le **supprime** s'il a moins de 48 h. Sinon on le **désépingle seulement** (si `pinMessagesEnabled`, aucun appel sinon), et il reste visible plus haut dans la conversation. C'est l'amendement de CA-9 accepté par Vinz le 2026-10-24 ;
  4. épingler le nouveau (si `pinMessagesEnabled`).

  **Échec du retrait** (décision de Vinz du 2026-10-24, R2-3) : si la suppression de l'ancien échoue, on tente son désépinglage. Si le désépinglage échoue (après une suppression ratée, ou seul pour un ancien roster de plus de 48 h, C1-1), le nouveau roster **n'est pas épinglé** (pour ne pas monter à 3 épinglés et faire tomber le sondage) et un Telegram le signale.

  **Roster orphelin épinglé** (décision de Vinz du 2026-10-25, C2-1) : l'ancien roster resté épinglé est mémorisé sur le job, avec la date d'expiration de son épinglage (date d'épinglage + 7 jours, `PIN_DURATION`). Tant que cette date n'est pas passée, **aucun roster n'est épinglé**, même si les retraits suivants réussissent. À chaque tick, le désépinglage de l'orphelin est retenté en best-effort : s'il réussit, ou si la date est passée, l'orphelin est oublié et l'épinglage normal reprend.

  Le groupe n'est jamais sans roster. Une règle vise au plus 2 épinglés (sondage + roster). Seule exception : après un échec de retrait, l'orphelin reste épinglé avec le sondage, et aucun autre roster n'est épinglé tant qu'il est mémorisé (ci-dessus). On reste donc à 2 épinglés au plus. La limite WhatsApp de 3 vaut **par groupe** (R2-15) : deux règles actives sur un même groupe la dépasseraient et feraient tomber le plus ancien épinglé. C'est exclu en pratique par la règle « une seule règle active par groupe » (§7 des règles fonctionnelles).
- **Écrivain unique** : la publication par le pipeline (collecte, annonce) et celle du tick ne doivent jamais envoyer deux rosters pour un même changement. Le mécanisme (verrou ou mise à jour conditionnelle en base) est laissé au concepteur.
- **Fin (CA-10)** : au début du premier créneau réservé, plus aucune publication. Le roster et le sondage sont désépinglés (tick existant).
- **Échecs** :
  - envoi, suppression, épinglage ou désépinglage : un Telegram `[règle] …`, jamais bloquant ;
  - un envoi échoué est retenté au tick suivant (l'empreinte publiée n'a pas changé) ;
  - le Telegram d'échec est dédupliqué comme celui du désépinglage du récap.

### 4.8 Messages en aval

Décision de Vinz du 2026-10-24 :
- La **confirmation WhatsApp** (étape 5) et le **rappel avant le match** affichent les inscrits du roster courant, au lieu de « Oui au sondage » figé.
- Le libellé devient « Inscrits : ». Il liste, par heure, les **inscrits** du roster, sans la liste d'attente ni les mentions « (remplace … ) » (R2-17).

Sinon, ces messages contrediraient le roster (Henry affiché alors qu'il s'est désisté).

### 4.9 Telegram

Pas de message par remplacement ni par entrée en liste d'attente (choix de Vinz). Telegram ne reçoit que les échecs (§4.7) et les messages existants, inchangés.

**Amendement du 2026-10-25 (décision de Vinz, B1-4)** : un votant tardif à numéro resté non identifié (inconnu de resa-squash ou recherche en échec) déclenche un Telegram, une fois par votant et par job, au format des votants non identifiés de la collecte, pour rendre visible le recours « Recalculer le plan » (§4.2, R2-7).

## 5. Données et documentation

- **Migration** (n° suivant) sur `job_runs`, pour garder l'état du roster :
  - le roster publié : `msgId`, `jid`, date d'envoi, empreinte, phase ;
  - la photo de collecte et la base du définitif : état des votes, `votedAt` et téléphones, noms mémorisés, `T_plan`, `event_id` intégrés ;
  - le désépinglage du sondage (décision R1-10) : par exemple `poll_unpinned_at`, puisque `poll_msg_id` ne peut pas être « oublié » comme `recap_msg_id` ;
  - le roster orphelin épinglé (décision C2-1) : `msgId`, `jid` et date d'expiration de son épinglage.

  Le tick lit la base en base de données, pas dans le checkpoint. La base du définitif contient aussi ce que le tick doit afficher du plan (R2-14) : plafond par heure, créneaux réellement pris (bloc des courts, lignes d'échec, nombre de joueurs non réservés), et mode réel ou dry-run avec le titre (`buildAnnounceTitle`), figés à l'annonce (C1-8).
  - Retirer un roster (fin sans réservation) remet son empreinte à zéro **et oublie son `msgId` et son `jid`** (C1-2), pour qu'un « Recalculer le plan » ultérieur republie sans tenter de retirer un message déjà supprimé (R2-11). Le détail (réutiliser `recap_msg_id`/`recap_jid` ou non) est laissé au concepteur.
- **ADR-038** « Sondage conservé et roster vivant ». Il amende :
  - ADR-037 : mention de clôture du point 1 ; points 2, 3, 6 et 7 ; le recours du point 4bis (« Relancer » relit le sondage, puis le roster provisoire part à la place de « suppression et récap »), la lecture vide elle-même restant une erreur ; « Relire les réponses » reste retiré (R2-13) ; points 4 et 5 (conditions de suppression et garde-fou d'âge du sondage, sans objet pour les nouveaux jobs). Il revient aussi sur l'alternative écartée « fermeture différée », reprise sous une autre forme : le vote tardif n'est plus invisible, puisqu'il entre dans le roster ;
  - ADR-034 : point 2 (le sondage n'est plus désépinglé à la collecte) ; point 3 (l'annonce n'est plus épinglée à part, c'est le roster qui l'est) ; point 4 (au sondage suivant, le nettoyage porte sur le roster et le sondage du job précédent, en plus de l'annonce des anciens jobs).
- **`docs/spec/regles-fonctionnelles.md`** :
  - §2 : la question ;
  - §3 : collecte, récap → roster provisoire, « Relire les réponses », garde-fou d'annulation ;
  - §6 : annonce → roster définitif, confirmation, rappel, et les lignes « Épinglage WhatsApp » (sondage, collecte, annonce, sondage suivant) à réécrire ;
  - nouvelle sous-section « Roster vivant ».

## 6. Laissé au concepteur

- Le découpage en modules. Suggestion : un module pur `roster.ts` (état + règles §4.6 + rendu texte), testé sans I/O, et un module de publication.
- Le format exact de l'empreinte, et le stockage de la base.
- Le cache des `lookup_player_by_phone` pendant une passe.
- Le choix entre la colonne `payload` jsonb et une colonne dédiée pour filtrer les événements d'un sondage. Pas d'index si le volume reste faible (quelques dizaines d'événements par semaine).

## 7. Risques connus

- **huddle-bot redémarré** : s'il perd les clés du sondage, il ne déchiffre plus les votes, donc il n'y a plus d'événement et le roster se fige. C'est le même risque qu'aujourd'hui pour la collecte. Aucune parade dans ce périmètre ; à noter dans l'ADR.
- **Listener arrêté** : les événements arrivent en retard par redelivery JetStream. Ils sont appliqués à leur arrivée (§4.2), donc l'ordre « premier arrivé » devient celui de l'arrivée en base, pas celui du vote. C'est le prix accepté pour ne jamais réécrire un roster publié.
- **Règle désactivée en cours de semaine** : le listener ne persiste que les votes des groupes des règles actives (`apps/listener/src/allowlist.ts`). Le roster se fige donc. Limite acceptée.
- **Groupe du sondage** : le filtre des événements utilise le groupe où le sondage a réellement été envoyé (copie de la règle prise par le job), pas `whatsappGroupJid` de la règle live.
- **Sondage perdu par huddle-bot** (DOUTE) : huddle-bot résout `selectedOptions` contre les options du sondage. S'il les a perdues, un vote peut arriver comme `poll_vote_deletion` avec `selectedOptions` vide, donc lu comme un faux retrait. R2-16, révisée le 2026-10-25 : la prod montre que huddle-bot émet aussi des retraits vides pour de vrais désistements (`previousOptions` vide). Un retrait dont `selectedOptions` et `previousOptions` sont vides est donc appliqué comme un désistement si le registre connaît une option pour ce votant, avec un Telegram nommant le votant et son ancienne option pour vérification ; sans option au registre (ou événement périmé), il est ignoré sans message, sauf pour un votant `@lid` non rapproché (Telegram, état inchangé). Un retrait vide ne ferme pas son instant (`lastAt` = `occurredAt` − 1) : un revote de même horodatage s'applique.
- **Vote très proche de la collecte** : réglé par l'ensemble intégré et la règle de l'événement périmé (§4.2). Un événement absent de la photo est appliqué à son arrivée. Un événement déjà reflété par le `votedAt` de la photo est ignoré.

## 8. Traçabilité des critères d'acceptance

| CA | Couvert par | Testé par (à préciser dans le plan) |
|---|---|---|
| CA-1 sondage conservé + roster provisoire à la collecte | §4.1, §4.4 | test collectVotes : pas de `delete_message`, roster provisoire envoyé |
| CA-2 vote entre collecte et plan pris dans le plan | §4.2, §4.3 | test bookSlots : événement après la collecte → présent dans `confirmedPlayerIdsByTime` |
| CA-3 roster à la place de l'annonce (créneaux, inscrits, places libres, rappel de désistement) | §4.5. Les places libres sont lisibles par « (n/plafond) » à chaque heure, plus « — k place(s) libre(s) » dès que k > 0 | test du rendu + test de l'annonce |
| CA-4 5ᵉ « oui » à 9 h → attente, effectif 4 | §4.6 règle 2 | test unitaire roster |
| CA-5 Henry se retire → « Hugo2 remplace Henry » | §4.6 règle 1, rendu « Hugo2 (remplace Henry) », équivalent au libellé du CA | test unitaire roster |
| CA-6 place libre, deux votants → le premier prend, le second attend | §4.6 règle 2 | test unitaire roster (ordre d'arrivée en base : `created_at` puis `event_id`) |
| CA-7 place libre à 9 h, vote 10 h 30 → attente 10 h 30, 9 h reste libre | §4.6 règle 2 | test unitaire roster |
| CA-8 désisté qui revote → fin d'attente | §4.6 règle 2 | test unitaire roster |
| CA-9 **amendé 2026-10-24** : nouveau roster en bas ; l'ancien supprimé s'il a < 48 h, sinon désépinglé | §4.7 | test publication (< 48 h → `delete_message` ; > 48 h → `unpin` seul) |
| CA-10 après le début du 1er créneau → plus de roster | §4.7 | test publication/tick |
| CA-11 message texte → roster inchangé | §4.2, §4.6 règle 4 | test : seuls les `poll_vote_*` du sondage sont lus |

Autres tests demandés par la spec, hors CA (C1-5) :
- ordre de capture de la photo (`event_id` lus avant `get_responses`) et événement périmé (§4.2, R2-1) ;
- choix d'une place libre : sa propre place, sinon la plus ancienne (§4.6, R2-5) ;
- ordre recalcul → nouvelle recherche → plan (§4.3, R1-4) ;
- garde-fou d'annulation du sondage (§4.1, R1-8) ;
- fermeture PUC après la collecte (§4.1, R2-2) ;
- échec du retrait de l'ancien roster et roster orphelin : pas d'épinglage tant qu'il est mémorisé, reprise après désépinglage ou expiration (§4.7, R2-3, C2-1) ;
- votant `@lid` sans téléphone ni nom correspondant : compté sous son JID, avec un Telegram (§4.2, C1-4) ;
- retrait vide : appliqué si le votant avait une option, sinon ignoré (§7, R2-16).
