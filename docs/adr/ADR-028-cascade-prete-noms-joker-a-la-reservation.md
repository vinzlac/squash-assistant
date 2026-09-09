# ADR-028 – Cascade prête-noms puis joker à la réservation réelle

**Status:** accepted
**Date:** 2026-09-09

## Contexte

Suite de l'incident du 2026-09-08 (ADR-027). Le joker (ADR-024) a été refusé par TeamR pour
crédits épuisés (`PLAYER_BOOKING_LIMIT_REACHED` / `noCredits`) alors qu'il était en partenaire
sur la ligne Martin + joker. Deux enseignements :

1. **La position partenaire consomme un crédit TeamR.** L'hypothèse d'ADR-024 (« le joker est
   sans limite en partenaire ») est fausse : le joker a, comme tout licencié, deux crédits pour
   des réservations de 1 à 7 jours à l'avance.
2. **Ses crédits ne sont pas connaissables à l'avance.** TeamR répond 403 sur les réservations
   d'un tiers (`GET /bookings/user/{userId}`, cf. resa-squash `docs/teamr-api.md` §5), n'expose
   aucun solde de crédits, et le joker peut consommer les siens directement dans l'app TeamR.
   Le planning club ne donnerait qu'une estimation ; TeamR reste seul juge, au moment de
   réserver. Vérifier les crédits au plan (piste ouverte d'ADR-027) est donc abandonné.

Or, à la réservation réelle, seul le joker était tenté en remplacement d'un joueur refusé
(`tryJokerSubstitution`). Les prête-noms encore disponibles — volontaires du sondage (ADR-017)
et `substituteBookers` de la règle — n'étaient jamais essayés, alors qu'au plan ils passent
**avant** le joker (`resolveBookablePair`, règle du 2026-09-01).

## Décision

**Le joker est un prête-nom global, toujours d'accord, utilisé en dernier ; le process est le
même pour les prête-noms et le joker, au plan comme à la réservation.**

1. À la réservation réelle, sur un refus imputable à un joueur (`PLAYER_NOT_REGISTERED`,
   `PLAYER_BOOKING_LIMIT_REACHED`), la ligne est retentée avec la **même cascade qu'au plan**
   (`bookingSubstitutionCandidates`, `planning/jokerSubstitution.ts`) : volontaires du sondage,
   puis prête-noms de la règle, dans l'ordre, puis le joker. Un candidat lui-même refusé par
   TeamR passe simplement la main au suivant.
2. Un prête-nom peut prendre n'importe quelle place (titulaire ou partenaire) ; le joker reste
   **partenaire uniquement**, le partenaire valide étant promu titulaire (ADR-024, inchangé).
3. Le joueur refusé peut être **le joker lui-même** : il est alors remplacé par un prête-nom et
   n'est plus reproposé sur cette ligne.
4. Un prête-nom consommé à la réservation compte dans son plafond « maison » de résas/jour
   (ADR-016), lignes du plan comprises : au plafond, il est sauté (`RealBookingOptions`).
5. Les substitutions faites à la réservation, prête-nom ou joker, sont signalées sur Telegram
   (canal organisateur) avec le rôle du nom porté (« réservé au nom du prête-nom X » / « du
   joker Y »). Le groupe WhatsApp n'en voit rien (ADR-016).
6. **Un seul joker** par règle : une liste de jokers a été envisagée puis écartée, la cascade
   prête-noms + joker couvrant déjà le cas de l'incident sans migration ni formulaire.

Si toute la cascade échoue, la ligne devient un refus au sens d'ADR-027 : les autres
réservations sont conservées, le refus est signalé avec son motif.

## Conséquences

- Pas de migration, pas de changement d'UI : réutilise `volunteerSubstituteIds`,
  `BookingRule.substituteBookers` et `jokerBookerId` déjà présents dans l'état.
- `JokerSubstitution.kind` (`"substitute" | "joker"`) distingue le nom porté ; les entrées
  historiques sans `kind` sont lues comme joker.
- Le texte de synthèse Telegram passe de « réservé au nom de X » à « réservé au nom du joker X »
  / « du prête-nom X ».
- La piste « vérifier les crédits du joker au plan » (ADR-027) est fermée.
