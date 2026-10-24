# Sondage conservé et roster vivant après réservation (désistements, remplacements, liste d'attente)

## Problème

En tant qu'organisateur des sessions squash, je veux que le sondage reste accessible après la réservation et qu'un roster à jour des inscrits soit affiché dans le groupe, afin que les places libérées par des désistements soient reprises sans coordination manuelle et que chacun sache clairement qui joue.

Dernière occurrence : session du samedi 2026-10-24 au matin. La veille, Henry et Stef se sont désistés par message texte. Hugo2 (« on est à combien pour combien de courts ? ») et Terence se sont proposés par texte, et Vinz a coordonné à la main pour qu'ils prennent les places. Laurent est venu sans s'être signalé : le sondage avait été supprimé et il ne savait pas comment s'inscrire. Ces chassés-croisés arrivent au moins 2 fois par mois.

## Solution

Existant chez moi :
- squash-assistant (v1.3.0, ADR-037) supprime le sondage dès la collecte et publie un récap épinglé « 🔒 Inscriptions closes ». La spec dit « le sondage n'existe plus après la collecte ». Ce besoin **revient sur cette décision**.
- Les votes WhatsApp, ajouts comme retraits, arrivent déjà en temps réel dans squash-assistant. Ils sont relayés avec le pseudo resa-squash, mais seulement vers le groupe de test, sans lien avec le pipeline.
- footEntrePotes-assistant (ADR-0006, ADR-0009) a déjà un roster vivant :
  - message republié en bas du groupe et suppression de l'ancien ;
  - mention « (remplace X) » et liste d'attente ;
  - sondage jamais supprimé.
  C'est le modèle à reprendre.
- resa-squash : les réservations TeamR sont nominatives (titulaire et partenaire). Un bug connu de l'API TeamR empêche de modifier les participants ou d'annuler un créneau.

Contraintes WhatsApp vérifiées :
- On ne peut pas modifier un sondage déjà envoyé, ni son titre ni ses options. huddle-bot le refuse explicitement.
- Une édition de message texte n'est visible que dans les 15 min environ.
- Un message ne peut être supprimé pour tous que pendant 48 à 60 h environ.

Open source : rien de clé en main. Le plus proche est szemkhel/volley-bot (sondage hebdo de groupe sportif), sans plafond, sans liste d'attente et sans roster.

Options envisagées : réutiliser tel quel (impossible : l'existant supprime le sondage) ; construire en s'inspirant du roster de footEntrePotes-assistant.

## Valeur

- Temps : faible pour Vinz, quelques minutes de coordination au moins 2 fois par mois. Ça prolonge cependant la vision du projet, qui est de remplacer l'organisateur de bout en bout, jusqu'au jour J. Le gain principal est la clarté pour le groupe : liste des participants explicite, canal d'inscription toujours visible, fin des venues non annoncées.

## Verdict et critères d'acceptance

Verdict : construire

Raison :
- Le cas est fréquent (au moins 2 fois par mois).
- Le problème est concret et observé le 2026-10-24.
- Aucune solution existante ne le couvre.
- Les briques nécessaires existent déjà dans l'écosystème : votes en temps réel, et roster vivant éprouvé sur footEntrePotes-assistant.

Périmètre :
- Le sondage initial est conservé après la collecte et après la réservation. Il reste votable jusqu'au début du premier créneau.
- Un roster provisoire remplace le récap « Inscriptions closes » entre la collecte et la réservation.
- Après la réservation, le roster remplace le message d'annonce des créneaux.
- Le roster est republié à chaque changement de vote :
  - plafond par heure égal au nombre de « oui » retenus à la réservation ;
  - places attribuées au premier arrivé ;
  - liste d'attente automatique ;
  - remplacements explicites.

Hors périmètre :
- Toute modification, annulation ou changement de participant d'une réservation TeamR. Les créneaux restent au nom des joueurs d'origine.
- L'interprétation des messages texte libres, comme un désistement écrit ou un « peut-être » : seul le sondage fait foi.
- Le renommage du sondage, impossible sur WhatsApp.
- Le suivi après le début du premier créneau.

- CA-1 : Étant donné un sondage dont les votes viennent d'être collectés / Quand l'étape de collecte se termine / Alors le sondage est toujours présent et votable dans le groupe, et un roster provisoire listant les inscrits par heure est publié à la place du récap « Inscriptions closes ».
- CA-2 : Étant donné un joueur qui vote « oui » entre la collecte et la réservation / Quand la réservation est planifiée / Alors ce joueur est pris en compte dans le plan comme les autres « oui ».
- CA-3 : Étant donné des créneaux réservés pour 9 h et 10 h 30 / Quand la réservation est confirmée / Alors le groupe reçoit, à la place de l'annonce, un roster qui contient :
  - les créneaux (adjacents regroupés) ;
  - les inscrits par heure ;
  - les places libres par heure ;
  - le rappel que pour se désister il faut retirer son vote dans le sondage.
- CA-4 : Étant donné 4 inscrits retenus à 9 h à la réservation / Quand un 5ᵉ joueur vote « oui » pour 9 h sans désistement préalable / Alors le roster republié le montre en liste d'attente pour 9 h et l'effectif de 9 h reste à 4.
- CA-5 : Étant donné Henry inscrit à 9 h et Hugo2 premier en liste d'attente pour 9 h / Quand Henry retire son vote dans le sondage / Alors le roster republié indique « Hugo2 remplace Henry » et Hugo2 apparaît parmi les inscrits de 9 h.
- CA-6 : Étant donné une place libérée à 9 h et personne en attente / Quand deux joueurs votent « oui » pour 9 h l'un après l'autre / Alors le premier votant prend la place et le second apparaît en liste d'attente.
- CA-7 : Étant donné 1 place libérée à 9 h et aucune à 10 h 30 / Quand un joueur vote « oui » pour 10 h 30 / Alors il apparaît en liste d'attente de 10 h 30 et la place de 9 h reste affichée libre.
- CA-8 : Étant donné un joueur désisté dont la place a été reprise / Quand il revote « oui » / Alors il apparaît en fin de liste d'attente de cette heure.
- CA-9 : Étant donné un roster déjà publié / Quand un vote change / Alors un nouveau roster est publié en bas du groupe et le précédent n'est plus visible.
- CA-10 : Étant donné le début du premier créneau de la session / Quand un vote change ensuite / Alors aucun nouveau roster n'est publié.
- CA-11 : Étant donné un joueur qui écrit « pas possible pour moi » dans le groupe sans toucher au sondage / Quand le message arrive / Alors le roster reste inchangé.

Questions ouvertes :
- Le roster provisoire (entre collecte et réservation) doit-il déjà afficher un plafond, ou seulement la liste des « oui » ?
- Faut-il notifier sur Telegram chaque remplacement ou entrée en liste d'attente, en plus du roster dans le groupe ?

Suite : `ship-feature --depuis-besoin docs/besoins/2026-10-24-roster-desistements.md` (depuis ~/workspace/squash-assistant)
