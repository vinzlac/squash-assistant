# ADR-014 – Vérification de disponibilité avant plan + snapshot versionné de la règle par job

**Status:** accepted
**Date:** 2026-07-22

## Contexte

Constat (2026-07-21) : à l'étape 3 (Plan de réservation), le plan choisit toujours le court en tête de `courtPriority` disponible, mais **sans vérifier en amont si la capacité totale des courts suffit** pour le nombre de joueurs confirmés. Concrètement :
- Avec `preferMinPlayersPerCourt` fixé statiquement dans la `BookingRule`, le plan ne s'adapte pas dynamiquement si les courts manquent (ex. 6 joueurs confirmés mais un seul court réellement libre à l'heure votée).
- Il n'y a aujourd'hui aucun message proactif prévenant le groupe qu'on pourrait être trop nombreux pour les courts disponibles, avant que le plan soit calculé.
- `plan_group_bookings` (resa-squash) sait déjà avancer à l'heure disponible suivante quand un round manque de courts (cf. `findEarliestWaveTime`), mais sans **plafond de fenêtre horaire** ni retour explicite "capacité insuffisante" exploitable en amont.
- Rien ne trace **quelle version de la `BookingRule`** a servi à construire un job donné — si la règle est éditée entre deux jobs (ex. `courtPriority`, `candidateStartTimes`), on ne peut plus reconstituer a posteriori la config réellement utilisée pour un job passé.
- L'étape 4 s'appelle "Confirmation & Annonce" alors qu'elle fait aussi la réservation réelle (potentiellement partielle) — nom trompeur une fois qu'on gère le cas "pas tout le monde n'a pu être casé".

## Décision

### 1. Snapshot de la règle par job (pas de table de versions séparée)

`jobRuns` gagne une colonne `ruleSnapshot: jsonb`, remplie une fois à la création du job (`createJobRun`) avec une copie complète de la `BookingRule` active à cet instant. Pas de nouvel écran d'historique : la traçabilité se fait en ouvrant le détail d'un job existant. Plus simple qu'un vrai versionnement (pas de table `booking_rule_versions`, pas de FK de version) — suffisant pour répondre au besoin exprimé ("retrouver la règle qui a servi à construire le job").

### 2. Nouveau paramètre `availabilityWindowHours` (défaut 3h)

Nouveau champ sur `BookingRule` : fenêtre de recherche de courts au-delà de l'heure votée, **après la 1ère heure candidate** (pas une fenêtre par heure candidate — plus simple, quitte à affiner plus tard si besoin). Sert de plafond à la recherche de créneaux de repli quand la capacité manque.

### 3. Étape de vérification de capacité, avant le calcul du plan (étape 3)

Nouvelle logique (pas forcément un nouveau nœud LangGraph séparé — à trancher en implémentation, potentiellement fusionné dans BookSlots) :
1. Pour chaque heure candidate avec des joueurs confirmés, appelle `plan_group_bookings` avec `preferMinPlayersPerCourt: true` (remplissage minimal, donc plus de courts utilisés — comportement actuel par défaut).
2. Si les `warnings` retournés indiquent une capacité insuffisante (pas assez de courts distincts disponibles pour caser tout le monde), **retente avec `preferMinPlayersPerCourt: false`** (remplissage maximal, jusqu'à `maxPlayersPerCourt` défini sur la règle) — escalade automatique, pas de nouveau paramètre MCP côté resa-squash nécessaire pour ça (le param existe déjà, cf. ADR-008 resa-squash).
3. Si toujours insuffisant : envoie un message Telegram **immédiatement** (avant même d'afficher le plan) signalant qu'on risque d'être trop nombreux pour les courts disponibles.
4. Le plan final reste **partiel + avertissement**, pas un blocage humain à ce stade (cohérent avec le principe déjà établi : le "go" à l'étape 4 est déjà le point de validation humaine avant écriture réelle — pas la peine d'en ajouter un 2e avant même de voir le plan).

### 4. Fenêtre de repli au-delà de l'heure votée (correction 2026-07-22 : aucun changement resa-squash nécessaire)

`plan_group_bookings` cherche déjà sur **toute la journée** disponible côté TeamR (pas de plafond horaire aujourd'hui, seulement un plancher `startTime`) et avance déjà tout seul à l'heure suivante quand un round manque de courts (`findEarliestWaveTime`) — l'étalement existe donc déjà dans la réponse, sans rien changer côté resa-squash.

Ce qui manque est **entièrement côté squash-assistant** : en post-traitement du plan reçu, comparer le `slotTime` réel de chaque `proposedBooking` à `heure votée + availabilityWindowHours`. Les réservations qui tombent **dans** la fenêtre sont conservées normalement ; celles qui tombent **au-delà** sont traitées comme "non casées dans la fenêtre acceptée" — exclues de `reserve_slot` (announce.ts) et comptées dans l'avertissement de capacité, plutôt que réservées aveuglément à une heure que le groupe n'a pas explicitement votée. squash-assistant décide déjà de quoi réserver via l'API existante (`reserve_slot` appelé un par un) — ce filtre est un ajout local, pas une évolution d'API.

### 5. Renommage étape 4 + message de sursaturation

"Confirmation & Annonce" → **"Réservation et annonce"**. Si des joueurs confirmés n'ont pas pu être casés (même après escalade + étalement), le message final envoyé au groupe WhatsApp l'indique explicitement (ex. "⚠️ N joueur(s) n'ont pas pu être réservés — capacité des courts dépassée").

## Conséquences

- Migration DB : `jobRuns.ruleSnapshot jsonb` (squash-assistant).
- Nouveau champ `BookingRule.availabilityWindowHours` (défaut 3), éditable via `RuleForm`.
- Logique d'escalade min→max dans `bookSlots.ts` (ou nouveau nœud dédié) : 2 appels `plan_group_bookings` par heure candidate en cas de capacité insuffisante, au lieu d'un seul.
- Message Telegram proactif de capacité, avant l'affichage du plan à l'étape 3.
- Filtre "hors fenêtre" en post-traitement du plan (`bookSlots.ts` ou `announce.ts`) : aucune évolution d'API resa-squash nécessaire, tout reste dans squash-assistant.
- Renommage UI de l'étape 4 (`Pipeline.tsx`), pas de changement de state machine.

## Points encore ouverts (à trancher avant implémentation)

- Aucun changement resa-squash requis — tout le périmètre (1 à 5) est réalisable dans squash-assistant seul.

## Addendum (2026-07-22) : historique complet des règles, pas seulement le snapshot par job

Après implémentation, besoin exprimé d'un vrai historique consultable des règles, indépendant des jobs (le snapshot par job — point 1 — ne montre que la version active au moment de la création d'UN job donné, pas l'évolution complète d'une règle dans le temps). Ajout :

- Table `booking_rule_history` (`bookingRuleId`, `snapshot` jsonb, `changedAt`) — une ligne par sauvegarde (création, édition via `RuleForm`, activation/désactivation).
- Page `/rules/[id]/history` listant toutes les versions passées (date, nom, activée/non, détail JSON complet).
- Lien "Historique de la règle" ajouté sur la page d'édition.

Ce n'est toujours pas un vrai diff (pas de calcul "qu'est-ce qui a changé entre 2 versions") — chaque entrée est une capture complète, à comparer manuellement si besoin. Suffisant pour l'usage actuel (mono-utilisateur, peu de règles).
