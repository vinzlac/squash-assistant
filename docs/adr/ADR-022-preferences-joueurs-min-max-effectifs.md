# ADR-022 – Préférences joueurs : min/max créneaux effectifs (vs plafond TeamR)

**Status:** accepted
**Date:** 2026-08-06

## Contexte

Après le moteur local (ADR-018) et la prolongation / fusion cross-heures avec temps de jeu effectif en rotation, le quota « combien de temps un joueur doit jouer » restait confondu avec :

- `BookingRule.maxReservationsPerPlayer` — nombre de **couches initiales** de paires pour une heure candidate ;
- `BookingRule.maxDailyReservationsPerPlayer` — plafond **TeamR** (lignes de réservation au nom d’un joueur non-titulaire, ADR-016).

En pratique (ex. Squash Académie mardi : Vincent/Terence @18H45 + Martin @19H30), le besoin métier est : **temps de jeu effectif** configurable (globalement et par joueur), **sans** remplacer le plafond TeamR du groupe. Un joueur peut devoir atteindre 2×45 min effectives alors que sa paire d’origine est déjà à 2 lignes TeamR — d’où l’usage des prête-noms pour ouvrir les créneaux manquants sur le même court.

## Décision

### 1. Option B — prefs = temps effectif seulement

- **`defaultMinPlaySlots` / `defaultMaxPlaySlots`** dans `app_settings` (défaut **2/2**, unités = créneaux de 45 min).
- Surcharges optionnelles par `userId` resa-squash dans **`player_preferences`** (`minPlaySlots` / `maxPlaySlots`, clamp applicatif 1..6 et min ≤ max).
- Absent de surcharge → défauts globaux.
- Ces quotas pilotent la **prolongation / rotation** (`sessionExtension`, `planJobBookings`) : viser le **min** effectif de chaque confirmé ; ne pas prolonger uniquement pour remplir le max.
- **`BookingRule.maxDailyReservationsPerPlayer`** reste le plafond TeamR uniforme du groupe (inchangé).
- **`BookingRule.maxReservationsPerPlayer`** reste le nombre de couches initiales de paires (`slotsPerPlayer` dans `computeGroupBookingPlan`).

### 2. Garantie du min via prête-noms

Tout joueur confirmé doit atteindre son min effectif. Si la paire d’origine est saturée au plafond TeamR de la règle, le moteur ouvre les créneaux suivants au nom du late joiner + d’un prête-nom (volontaires ADR-017 puis `substituteBookers` ADR-016), pendant que la rotation physique continue. Sans prête-nom → warning de shortfall. Un prête-nom n’ouvre jamais un 2ᵉ court pour un effectif impair seul (règle déjà actée).

### 3. UI admin `/players`

Page dédiée (lien depuis l’accueil) : édition des défauts globaux + tableau des membres (union des `resaSquashGroupId` des règles via `list_group_members`) avec overrides. Admin only.

### 4. Chargement I/O hors du moteur pur

`loadPlaySlotsConfig(db)` lit défauts + overrides ; `bookSlots` et le simulateur HTTP passent le résultat à `planJobBookings` (fonction pure). Les tests unitaires / fixtures n’ont pas besoin de Postgres.

## Raisons

- Séparer « combien on veut jouer » (effectif) de « combien de lignes TeamR au nom de qui » (courtoisie / quota groupe) évite de tordre `maxDailyReservationsPerPlayer` pour exprimer une préférence individuelle.
- Défauts globaux + overrides par joueur couvrent le cas courant (tout le monde 2/2) sans multiplier les champs sur chaque `BookingRule`.
- Réutiliser le pool prête-noms existant (ADR-016/017) pour la garantie du min évite un nouveau mécanisme TeamR.

## Conséquences

- Migration `0020_player_play_slots.sql` : colonnes `app_settings.default_min/max_play_slots`, table `player_preferences`.
- Modules : `playerPlaySlots.ts`, `loadPlayerPlaySlots.ts` ; branchement dans `sessionExtension.ts`, `groupBookingPlan.ts`, `planJob.ts`, `bookSlots.ts`, `simulateScenario.ts`.
- UI : `apps/ui/src/app/players/`, `lib/playerPreferences.ts`, actions serveur.
- Spec : `docs/spec/regles-fonctionnelles.md` (temps effectif + prefs).
- Déployé en prod (`de91c71`, 2026-08-06) — migrate via initContainer (ADR-012), validé en usage réel.
- Met à jour la lecture d’ADR-018 §4 : les « bornes min/max de créneaux par joueur » ne sont plus uniquement `maxReservationsPerPlayer` — voir cet ADR pour le temps effectif.
- Voir aussi ADR-016 (prête-noms / plafond TeamR) et ADR-017 (volontaires).
