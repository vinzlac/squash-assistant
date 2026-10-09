# Clôture du sondage à la collecte + récap des inscrits — design

Date : 2026-10-09
Statut : proposé — relu par un agent indépendant le 2026-10-09, corrections intégrées

## Contexte

Job `04578758` (« squash-samedi-matin v2 », samedi 2026-10-10) :

- La collecte des votes et le calcul du plan sont partis ensemble à `decisionTime` (lundi 05/10 9h00 Paris). Henry (vote 10H30 le 07/10) et Stef (prête-nom le 06/10) ont répondu **après** : votes jamais pris en compte, sans que personne ne le sache. Le sondage restait votable dans WhatsApp.
- Thomas LECCIA et Vince avaient répondu « Non, mais je peux prêter mon nom » mais leur téléphone n'est associé à aucun compte resa-squash : rangés dans `unresolvedNames`, ils n'apparaissaient sur Telegram que noyés dans le message « Confirmés par heure ». Résultat : « Prête-noms volontaires : (aucun) ».
- Le groupe Vincent+Hugo demandait 3 rounds (minSlots=3) avec un plafond de 2 résas/jour : le planificateur a réessayé chaque créneau de 12H00 à 18H00 (`continue`), un warning par créneau, d'où la synthèse illisible.
- L'annonce WhatsApp disait « 1 joueur(s) n'ont pas pu être réservé(s) » alors que les 4 joueurs jouaient (`computeShortfall` compte des rounds, pas des joueurs).

## Principe transverse : WhatsApp ≠ Telegram

- **WhatsApp** = les joueurs. Messages concis, sans détail technique, sans ⚠️ qui ne les concerne pas.
- **Telegram** = l'organisateur / développeur (debug). Détails techniques bienvenus : téléphones, causes, ids.
- **Ton** : des emojis dès que ça rend la communication plus sympa (😉, 🙏, 🎾, :)), surtout côté WhatsApp.

Tout message défini ci-dessous respecte cette séparation.

## 1. Clôture du sondage

### 1.1 Date de clôture dans le sondage

`buildPollQuestion` ajoute la clôture à la question :

> Squash samedi 10 octobre à 10h30 ? (réponses jusqu'au lundi 5 octobre à 9h)

- Date = date cible − `decisionDaysBefore` jours, heure = `decisionTime` (déjà « HH:MM » heure de Paris, aucun passage par l'UTC). Formats existants : `formatInformalDate` et `formatSessionTime` (« 9h », « 21h30 »).
- `decisionDaysBefore = 0` (décision le jour du match) : même format, le jour affiché est le jour du match.
- Combinaison avec la mention « puc fermé » existante : la clôture vient en dernier.
- Lue sur la **règle live** au moment de l'envoi (le cron de décision lit aussi la règle live, `cronRegistry.ts`), via `getBookingRuleById` ; repli sur la copie du job si la règle est introuvable ou illisible. Une modification de la règle entre le sondage et la décision rend l'heure affichée fausse : accepté.
- Mention **omise** si la clôture calculée est déjà passée au moment de l'envoi (job manuel tardif).
- Job manuel : même texte (une collecte manuelle plus tôt ferme plus tôt, c'est assumé).
- L'aperçu UI de l'étape 1 (`buildPollQuestionPreview`, `apps/ui/src/lib/pipelinePreview.ts`) est mis à jour en même temps.

### 1.2 Fermeture à la collecte (étape 2)

**Contrainte découverte à la relecture** : après `delete_message`, huddle-bot retire le sondage de son store et `get_responses` renvoie « aucune_reponse » pour tout le monde, **sans erreur**. Toute relecture après suppression produirait donc silencieusement un plan vide. La spec garantit qu'on ne relit jamais un sondage fermé.

Dans le nœud `CollectVotes`, auto ou manuel, dans cet ordre :

1. **Sondage déjà fermé ?** (`job_runs.poll_closed_at` non null, cas d'une relance de l'étape après un échec) : on ne relit pas. Les votes sont repris du `detail` du dernier événement `collect_votes` réussi du job ; s'il n'existe pas, l'étape échoue explicitement (« sondage fermé, votes introuvables ») avec un message Telegram. Sinon, si `pollMsgId` est connu : (a) si un événement `poll_deleted` réussi existe pour le job (écrit à la collecte après une suppression réussie, §1.2), la suppression a déjà abouti — rien n'est retenté ni signalé ; (b) sinon, même garde-fou d'âge qu'à la collecte (même calcul, `POLL_DELETE_MAX_AGE_HOURS`) : au-delà de 48 h ou date introuvable, pas de nouvelle tentative et Telegram `[règle] Relance de la collecte : sondage envoyé il y a N h (au-delà de 48 h), suppression non retentée — vérifier dans le groupe et le supprimer à la main s'il est encore là.` (« date d'envoi du sondage introuvable » si la date manque) ; (c) sinon `delete_message` est **retenté** en best-effort : la suppression a pu ne pas aboutir (pod tué juste après `poll_closed_at`). Tout échec, « Message not found » compris (sans `poll_deleted`, on ne distingue pas un sondage déjà supprimé d'un store huddle-bot perdu — après un redémarrage de huddle-bot, son store mémoire est vide alors que le sondage est encore là), donne le Telegram `[règle] Relance de la collecte : suppression du sondage non confirmée (<erreur>) — vérifier dans le groupe et le supprimer à la main s'il est encore là.` Ni récap ni « Confirmés par heure » renvoyés ; l'étape réussit.
2. Lecture des votes (`resolveVotes`). **Si elle échoue, rien n'est supprimé** (l'étape échoue comme aujourd'hui, les votes restent dans WhatsApp). L'événement `collect_votes` (avec le résultat dans `detail`) est écrit à ce moment, comme aujourd'hui.
3. **Seulement si le groupe de l'annonce est le groupe du sondage** (§2.2, règle live via `resolveAnnounceNotifyJid`) — sinon on est en mode test : désépinglage seul comme aujourd'hui, pas de suppression, `poll_closed_at` reste null (une relance relit normalement, le sondage existant toujours) et on passe au point 4. Clôture : `poll_closed_at` est écrit **avant** `delete_message` (nouvelle colonne, migration 0033), pour qu'un pod tué entre les deux ne relise jamais un sondage supprimé ; il est remis à null si la suppression échoue. Suppression : `delete_message` sur `whatsappGroupJid` / `job.pollMsgId` (si `pollMsgId` est inconnu : pas de suppression, Telegram « sondage non supprimé : msgId inconnu »). Un sondage supprimé perd son épinglage avec lui : le désépinglage n'est tenté qu'en cas d'échec de suppression. Échec de suppression : signalé sur Telegram (`[règle] Suppression du sondage échouée : …`), `poll_closed_at` remis à null, le pipeline continue. Suppression réussie : événement `poll_deleted` (statut `success`, `detail: { pollMsgId }`, même table `events`, via `emitEvent`) ; écriture best-effort (échec → Telegram `[règle] Sondage supprimé mais événement poll_deleted non enregistré : …`, jamais bloquant ; la relance retentera alors comme avant).
4. Tout ce qui suit est **non bloquant** (try/catch, échec signalé sur Telegram) : message Telegram « Confirmés par heure » (existant), message « votants non identifiés » (§3), récap des inscrits (§2). Un échec ici ne doit jamais faire rejouer le nœud.

Pourquoi la suppression : WhatsApp n'offre pas de fermeture native d'un sondage. Le groupe verra « message supprimé » à la place.

**Garde-fou d'âge (relecture du 2026-10-09)** : WhatsApp ne permet la suppression « pour tout le monde » que pendant ~60 h (au-delà, le message ne disparaîtrait que pour le bot). Constante `POLL_DELETE_MAX_AGE_HOURS = 48` : avant toute suppression, âge = maintenant − `createdAt` de l'événement `poll` du job (celui dont on lit `detail.question`). Âge > 48 h ou date introuvable : pas de suppression, `poll_closed_at` reste null, désépinglage seul, et Telegram `[règle] Sondage non supprimé : envoyé il y a N h (au-delà de 48 h, WhatsApp ne permet plus de le supprimer pour tous) — à supprimer à la main dans le groupe si besoin.` (N arrondi à l'heure inférieure ; « date d'envoi introuvable » à la place si la date manque).

**Garde-fou de mise en prod** : la suppression ne s'applique qu'aux sondages qui annonçaient leur clôture, détecté sur le texte réellement envoyé (`detail.question` de l'événement `poll` du job contient « réponses jusqu'au »). Pas de date de mise en service à régler : un sondage parti avant le déploiement, ou dont la mention a été omise (clôture déjà passée à l'envoi), garde l'ancien comportement (désépinglage seul).

**UI** : une fois l'étape 2 faite, l'aperçu `pollTally` et le lien « Rafraîchir les réponses » sont masqués (ils afficheraient « personne n'a répondu »). Les votes collectés restent visibles comme aujourd'hui.

**Effets de bord à traiter** :
- `cancelJobForClosure` (fermeture du PUC après la collecte) : si `poll_closed_at` est renseigné, ne pas rappeler `delete_message`, considérer le sondage comme supprimé (`pollDeleted = true`), ne pas écrire « Ignorez le sondage » dans le message, et désépingler le récap tout de suite.
- `handleCancelPoll` (`server.ts`) : refuser côté serveur si `poll_closed_at` est renseigné (aujourd'hui seule l'UI protège).

### 1.3 Retrait de « Relire les réponses »

Le sondage n'existant plus après la collecte, la relecture n'a plus d'objet. Sont supprimés : le bouton dans `Pipeline.tsx`, l'action UI `recollect-votes` (`actions.ts`, union d'actions de `apps/ui/src/lib/worker.ts`), la route worker (regex de `server.ts`), `triggerRecollectVotes` (scheduler), les commentaires qui la citent, et la ligne correspondante de `regles-fonctionnelles.md` (§3). Le cas `bookSlots` de `pausedOnFromSnapshot` est **conservé** (utilisé par `triggerRecomputePlan`). `cancelPollAction` (annulation tant qu'aucun vote n'est collecté) est inchangé côté UI.

### 1.4 Épinglage du sondage (vérification demandée)

Comportement existant : épinglé à l'envoi (étape 1, si `pinMessagesEnabled`), retiré à la collecte (étape 2). En auto, la collecte et le plan partent ensemble à `decisionTime`, donc le sondage est épinglé de l'étape 1 jusqu'au début de l'étape 3. Avec cette spec, le retrait se fait par la suppression du message (désépinglage explicite seulement si la suppression échoue).

Limite connue : WhatsApp garde au plus 3 messages épinglés par groupe. Une règle seule n'en utilise que 2 au maximum (récap + annonce). Si plusieurs règles partagent un groupe, WhatsApp retire le plus ancien sans prévenir.

## 2. Récap des inscrits (WhatsApp)

### 2.1 Contenu

```
🔒 Inscriptions closes — samedi 10 octobre 🎾
⏰ 10h30 (4) : Hugo MERCIER, Vincent LACOSTE, Gaëtan COATANROCH, Martin MERLOT
🙏 Merci à Thomas LECCIA et Vince pour les prête-noms :)
Les courts arrivent bientôt 😉
```

- Une ligne par heure candidate ayant au moins un inscrit, au format `⏰ heure (n) : noms`, heure au format du sondage (`formatSessionTime` : « 10h30 », pas « 10H30 » TeamR).
- Ligne prête-noms seulement s'il y a des volontaires, **identifiés ou non** : on remercie tout le monde, sans ⚠️. Un seul volontaire : « 🙏 Merci à X pour le prête-nom :) ».
- Noms : nom renvoyé par `lookup_player_by_phone` à la collecte (prénom + nom, toujours disponible pour un votant identifié — mémorisé dans l'état `voterNames`), jamais un identifiant resa-squash brut. Un votant non identifié apparaît avec son nom WhatsApp (`displayName`), sans marque particulière — jamais un téléphone ni un JID : nom vide, purement numérique ou contenant `@` → « un joueur » ; toute suite d'au moins 6 chiffres (espaces, points, tirets, parenthèses, « + » intercalés compris) est retirée du nom, sans laisser de parenthèse orpheline ni de séparateur en début/fin, espaces multiples réduits (« Vince +33 6 63 89 21 86 » → « Vince », « Max (+33) 6 12 34 56 78 » → « Max »), « un joueur » s'il ne reste rien. Une plage d'années (`(19|20)\d{2}` séparé par `-`, `–` ou `/` d'une autre année, ex. « Équipe 2024-2025 ») n'est pas un numéro : inchangée.
- Dernière ligne « Les courts arrivent bientôt 😉 » : l'annonce des réservations (étape 4) suit.
- Aucun inscrit : « 🔒 Inscriptions closes — samedi 10 octobre\nPersonne cette semaine 😢 » (pas de ligne finale sur les courts).
- **Sondage non supprimé à cette collecte** (ancien sondage sans marqueur, garde-fou d'âge, `pollMsgId` inconnu, écriture de `poll_closed_at` ou suppression en échec) : le récap, envoyé sur le groupe du sondage encore votable, ne dit pas « Inscriptions closes ». `buildRegistrationRecapMessage` reçoit `pollClosed: boolean` ; faux → en-tête « 📋 Inscrits — samedi 10 octobre 🎾 » (sans inscrit : « 📋 Inscrits — samedi 10 octobre\nPersonne pour l'instant 😢 »), le reste inchangé. Mode test (récap sur le groupe test) : `pollClosed` vrai, la clôture y est simulée.
- Envoyé aussi en dry-run (comme l'annonce).

### 2.2 Destinataire

Groupe de l'annonce (`reservationNotifyWhatsappGroupJid`, repli sur `whatsappGroupJid`), lu sur la règle live via `resolveAnnounceNotifyJid`, comme l'annonce. Aucun nouveau réglage. Envoyé aussi en dry-run.

**Mode test** (groupe de l'annonce ≠ groupe du sondage) : le récap part sur le groupe test et le vrai groupe n'est pas touché — le sondage n'y est **pas supprimé**, seulement désépinglé comme aujourd'hui (§1.2). Conséquence assumée : tant que la règle est en mode test, un vote tardif reste possible dans le vrai groupe et n'est pas pris en compte. La fermeture effective arrive quand l'annonce bascule sur le groupe du sondage.

### 2.3 Épinglage

- Si `pinMessagesEnabled` : épinglé (`pinBestEffort`, durée `7d` comme le reste : filet seulement, `decisionDaysBefore` ≤ 7 en pratique).
- `msgId` et groupe mémorisés sur le job : nouvelles colonnes `job_runs.recap_msg_id` / `job_runs.recap_jid` (migration 0033, nullable).
- **Désépinglage le jour du match**, à l'heure du premier créneau réservé (heure de Paris) ; à 23h59 si aucun créneau n'est réservé :
  - porté par le tick global à la minute (ADR-036), mais **indépendant du rappel** : requête dédiée sur `job_runs WHERE recap_msg_id IS NOT NULL`, sans filtre sur `enabled`, `startReminderEnabled` ni l'annulation du job ;
  - condition : `targetDate < aujourd'hui` (rattrapage si le pod était arrêté) OU (`targetDate = aujourd'hui` ET heure de Paris ≥ premier créneau réservé, ou ≥ 23h59 sans créneau) ;
  - job annulé (fermeture du PUC, annulation manuelle) après l'envoi du récap : désépinglé **tout de suite** à l'annulation.
- Abandon : si la date du match est passée depuis plus de 7 jours, `recap_msg_id` est remis à null sans appeler huddle-bot (l'épinglage `7d` a expiré) — évite de réessayer indéfiniment un désépinglage impossible (message supprimé à la main, bot retiré du groupe).
- Sinon : `recap_msg_id` n'est remis à null que si le désépinglage a réussi (comme `sendPoll.ts` pour l'annonce), et le sondage suivant de la règle désépingle un récap resté épinglé (requête dédiée sur `recap_msg_id`, distincte de `findPreviousPinnedAnnounce`), indépendamment de la case.

## 3. Telegram : votants non identifiés

### 3.1 Message dédié

Envoyé à la collecte, **avant le récap**, dès qu'au moins un votant (heure **ou** prête-nom) n'est pas identifié :

```
[squash-samedi-matin v2] ⚠️ 2 votant(s) non identifié(s) — impossible de savoir qui c'est, exclu(s) du plan :
  • Vince (+33663892186, numéro inconnu de resa-squash) — « Non, mais je peux prêter mon nom »
  • Thomas LECCIA (+33686870364, numéro inconnu de resa-squash) — « Non, mais je peux prêter mon nom »
→ Associer ce numéro à leur compte TeamR/resa-squash, puis « Recalculer le plan » avant le go.
```

Deux causes, deux libellés : « numéro inconnu de resa-squash » (téléphone présent mais aucun compte) et « pas de numéro WhatsApp » (`phone: null`).

Le suffixe « non résolu(s) » du message « Confirmés par heure » est retiré (doublon).

### 3.2 Changement de `resolveVotes`

`unresolvedNames: string[]` devient `unresolvedVoters: Array<{ name: string; phone: string | null; option: string }>`. Consommateurs à adapter : `collectVotes.ts` et le `detail` de l'événement `collect_votes` (seuls usages actuels, la relecture étant supprimée).

La synthèse (§3.4), le récap (§2) et le recalcul (§3.3) en ont besoin plus tard : **nouvelle annotation `unresolvedVoters` dans `state.ts`**, valeur par défaut `[]` pour les checkpoints existants. Le récap affiche les votants identifiés par leur nom resa-squash ; seuls les non-identifiés passent par leur nom WhatsApp (`displayName`).

### 3.3 Reprise au « Recalculer le plan »

Un votant non identifié est listé dans le récap (il s'est bien inscrit) mais exclu du plan. Le plan attend le « go » : l'organisateur peut associer son numéro dans TeamR/resa-squash puis cliquer « Recalculer le plan » (`triggerRecomputePlan`). Le recalcul relance alors `lookup_player_by_phone` pour chaque `unresolvedVoters` ayant un téléphone :

- identifié et option = heure candidate → ajouté à `confirmedPlayerIdsByTime[heure]` ;
- identifié et option = prête-nom → ajouté à `volunteerSubstituteIds` ;
- toujours inconnu → reste dans `unresolvedVoters` ;
- recherche en échec (panne resa-squash) → reste dans `unresolvedVoters`, libellé Telegram « recherche en échec (<message>) » au lieu de « toujours inconnu », `console.warn` avec la cause ; le recalcul n'est pas bloqué.

Telegram signale le résultat (`[règle] Recalcul : Vince identifié (prête-nom), Thomas LECCIA toujours inconnu`). Le récap WhatsApp n'est pas renvoyé. Pas de relecture du sondage (il est fermé) : seule la recherche par téléphone est rejouée.

### 3.4 Synthèse du groupe test

La synthèse (groupe test uniquement) liste les volontaires non identifiés par leur nom WhatsApp avec « ⚠️ non identifié » au lieu de « (aucun) ». C'est un message de debug sur un groupe test, le ⚠️ y est permis.

## 4. Correctifs du même lot

### 4.1 Planificateur : arrêt au plafond (`scheduleGroupTimeline.ts`)

Quand la paire du round à réserver est bloquée (plafond de résas/jour **ou** joueur non réinscrit) et que ni prête-nom ni joker ne la débloque, la recherche des rounds restants du groupe **s'arrête** (`break`). Justification : `roundIndex = bookings.length` ne bouge pas après un échec, donc la paire est identique au créneau suivant, et l'ensemble des joueurs bloqués ne dépend pas du créneau. L'échec se répéterait à l'identique : le `break` ne fait perdre aucun round réservable. Un seul warning, avec ses deux variantes existantes pour le joker :

> Vincent LACOSTE, Hugo MERCIER : 3e round demandé mais plafond 2 résas/jour atteint — aucun prête-nom disponible et joker déjà mobilisé.

(ou « … et aucun joker configuré sur la règle » ; cause « pas réinscrit pour la saison » pour l'autre cas). Le warning final « n/N round(s) réservé(s) — créneaux insuffisants » n'est plus émis dans ce cas (la cause n'est pas le manque de créneaux).

**Prête-noms perdus** : `resolveBookablePair` retire un prête-nom de `substituteQueue` (`splice`) puis peut renvoyer `null` ; le prête-nom est alors perdu pour les groupes suivants. Correctif : travailler sur une copie de la file et ne valider la consommation qu'en cas de succès.

Hors périmètre : dans un groupe de 3, essayer la paire suivante du cycle quand la paire courante est bloquée.

### 4.2 Compteur de l'annonce (`announce.ts`)

« ⚠️ N joueur(s) n'ont pas pu être réservé(s) cette semaine » compte des **joueurs confirmés sans aucun créneau réservé**. Un round manquant d'un groupe qui joue n'est plus compté.

Les réservations ne permettent pas de retrouver le groupe de court (toutes portent le `groupId` de l'heure candidate, et prête-noms/joker portent les lignes TeamR). Le planificateur expose donc l'appartenance :

- `plan.meta.courtGroups: Array<{ members: string[]; sessionIds: string[] }>`, rempli par les deux branches du moteur (`scheduleGroupTimeline` et le cas « queueing » de `groupBookingPlan.ts`), joueurs en rotation inclus dans `members` (ils jouent sans ligne TeamR et ne sont pas comptés).
- N = confirmés de l'heure absents de tout `courtGroup` + confirmés membres des `courtGroups` dont aucun `sessionId` n'est dans `reservedBookings` (exclut hors fenêtre et échecs de réservation). On ne compte que des votants confirmés : prête-noms et joueurs de marge ne sont jamais comptés.
- Ancien checkpoint sans `courtGroups` : N = 0 (ligne omise).

Ligne omise si N = 0.

### 4.3 Allègement des messages WhatsApp de l'annonce (`announce.ts`)

Demande utilisateur du 2026-10-09, application du principe WhatsApp concis :

- **Titre de l'annonce** sans nom de règle et sans « (s) », accordé au nombre de créneaux fusionnés annoncés :
  - réel : « 🏸 Réservation confirmée » (1) / « 🏸 Réservations confirmées » (≥ 2) ;
  - dry-run : « 🏸 Réservation » / « 🏸 Réservations ».
  - Le reste du message (📅 date, courts, notes d'échec et de capacité) est inchangé.
- **Signature supprimée** : la ligne « 🤖 Réservation effectuée automatiquement par squash-assistant. » disparaît. (Elle servait à distinguer l'annonce de la notification native resa-squash ; l'utilisateur accepte de perdre cette distinction.)
- **Message d'échec total** : « ⚠️ Réservation(s) « <règle> » du <date> : échec… » devient « ⚠️ Échec de la réservation du <date> : aucun court n'a été réservé. Contactez l'organisateur. » (sans nom de règle ni « (s) »).

**Hors repo (resa-squash, chantier séparé)** : la notification native de resa-squash (`app/services/group-booking-digest.ts`) envoyée sur WhatsApp via le bus NATS perd son titre « 🏸 Réservation(s) groupe « … » » et sa signature « Résa Squash », ainsi que la signature du rappel « ⏰ Rappel — groupe « … » ». **WhatsApp seulement** : les notifications Telegram perso des joueurs gardent le texte actuel (variante dédiée passée à `publishSquashReservedEventSafe`). Ce changement se fait dans le repo resa-squash, pas dans ce plan.

## 5. Documentation

- `docs/spec/regles-fonctionnelles.md` :
  - §3 : clôture à la collecte, suppression du sondage, retrait de « Relire les réponses », récap, message Telegram ;
  - section épinglage : récap des inscrits ;
  - synthèse du groupe test ;
  - principe WhatsApp ≠ Telegram ;
  - historique des décisions.
- ADR-037 : clôture du sondage par suppression du message WhatsApp à la collecte.

## 6. Tests

- `buildPollQuestion` et `buildPollQuestionPreview` : clôture (date cible − M, `decisionDaysBefore = 0`), combinaison avec « puc fermé », mention omise si clôture passée.
- `resolveVotes` : `unresolvedVoters` avec téléphone et option, votant sans téléphone.
- Nœud `CollectVotes` (huddle-bot simulé) :
  - ordre lecture → `poll_closed_at` → suppression → messages (remise à null si la suppression échoue) ;
  - aucune suppression si la lecture échoue ;
  - échec de suppression : Telegram, désépinglage tenté, `poll_closed_at` null, étape réussie ;
  - échec Telegram ou récap après suppression : étape réussie ;
  - relance avec `poll_closed_at` renseigné : votes repris de l'événement `collect_votes`, `get_responses` jamais appelé ; sans événement : échec explicite ;
  - sondage sans mention « réponses jusqu'au » (ancien sondage ou mention omise) : pas de suppression ;
  - `pollMsgId` inconnu : pas de suppression, Telegram ;
  - pod tué entre l'écriture de `poll_closed_at` et la suppression : la relance ne relit pas.
  - garde-fou d'âge : 47 h → supprimé ; 49 h → non supprimé, Telegram, désépinglage ; date absente → non supprimé ;
  - relance après clôture : suppression retentée, réussie → aucun Telegram ; en échec → Telegram ; `get_responses` jamais appelé ;
  - relance après clôture, garde-fou d'âge : 49 h ou date absente → pas de nouvelle tentative, Telegram ; 47 h → retentée ;
  - événement `poll_deleted` : écrit après une suppression réussie (pas après un échec), échec d'écriture → Telegram, étape réussie ; relance avec l'événement → aucune suppression ni Telegram (même au-delà de 48 h) ; sans → retentée ;
  - récap « 📋 Inscrits » quand le sondage n'est pas supprimé, « 🔒 Inscriptions closes » sinon et en mode test ;
  - invariant (vrai `withEventLogging`) : événement `collect_votes` écrit avant `poll_closed_at` et `delete_message`, aucun des deux si cette écriture échoue.
- Récap : plusieurs heures, aucun inscrit, 1 et plusieurs prête-noms, volontaire non identifié remercié par son nom WhatsApp, destinataire (groupe de l'annonce ≠ groupe du sondage).
- `cancelJobForClosure` après clôture : pas de `delete_message`, pas de « Ignorez le sondage », récap désépinglé. `handleCancelPoll` refusé après clôture.
- Désépinglage du récap : heure du 1er créneau, 23h59 sans créneau, rattrapage `targetDate` passée, règle désactivée ou rappel désactivé, job annulé (immédiat) ; `recap_msg_id` conservé si le désépinglage échoue.
- Mode test (groupe de l'annonce ≠ groupe du sondage) : pas de suppression, désépinglage seul, récap sur le groupe test.
- Recalcul du plan : non-identifié devenu identifié ajouté à son heure ou aux prête-noms, toujours inconnu conservé, recherche en échec distinguée (« recherche en échec »), `get_responses` jamais appelé.
- Récap : numéro retiré d'un nom WhatsApp (« Vince +33 6 63 89 21 86 » → « Vince », « Max (+33) 6 12 34 56 78 » → « Max », « 06 12 34 56 78 » → « un joueur », « Anaïs 2 », « Tom 12345 », « Équipe 2024-2025 » inchangés).
- `sendPoll` : clôture affichée lue sur la règle live, repli sur la copie du job.
- `scheduleGroupTimeline` : plafond → un seul warning et arrêt ; non-réinscrit → idem ; prête-nom restitué quand la paire reste bloquée.
- Compteur de l'annonce : cas du job 04578758 → 0 ; groupe sans aucune réservation → ses membres comptés ; rotateurs non comptés ; ancien checkpoint sans `courtGroups` → 0.

## Hors périmètre

- Pas de fermeture différée ni de relecture après clôture.
- Pas de nouveau réglage de groupe pour le récap.
- Le message d'annulation pour fermeture du club reste sur le groupe d'origine.
- L'association téléphone ↔ compte se fait à la main dans TeamR/resa-squash (la reprise automatique se limite au « Recalculer le plan », §3.3).
