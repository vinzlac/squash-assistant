# ADR-027 – Réservation réelle partielle : fin du tout-ou-rien (plus de rollback)

**Status:** accepted
**Date:** 2026-09-09

## Contexte

Jusqu'ici, l'étape 4 (`reserveAllForReal`, `apps/worker/src/graph/nodes/announce.ts`) réservait
les lignes du plan **séquentiellement en tout-ou-rien** : au premier `reserve_slot` refusé de
façon non rattrapable, elle annulait (`cancel_reservation`, best-effort) toutes les réservations
déjà passées du lot, puis relançait l'erreur. L'intention d'origine (ADR-014) était d'éviter une
réservation « partielle et incohérente » pour un plan multi-créneaux.

Incident réel du 2026-09-08 (job `fcd8c206`, règle `squashacademie-mardi v2`, cible 2026-09-15) :

- 6 lignes planifiées : courts 4 et 3 de 18H45 à 20H15 (deux paires), puis court 2 de 19H30 à
  21H00 pour Martin + le **joker** (Tin LAM n'étant pas réinscrit, le plan avait déjà substitué
  le joker, ADR-024).
- Les 4 premières réservations sont passées. La 5e a été refusée par TeamR :
  `PLAYER_BOOKING_LIMIT_REACHED` / `noCredits` — le joker avait déjà consommé ses deux crédits
  de la semaine. Le joueur refusé étant le joker lui-même, aucune substitution n'était possible.
- Le rollback a annulé les 4 courts déjà pris. Résultat : **zéro court** pour la soirée, alors
  que quatre étaient acquis, et un message WhatsApp « aucun court n'a été réservé ».

Le raisonnement de l'ADR-014 ne tient pas : chaque ligne est indépendante côté TeamR (paires
distinctes, courts distincts), et pour les joueurs, un court pris vaut toujours mieux qu'aucun.
Un plan partiellement réservé n'est pas « incohérent » — c'est simplement un plan avec des
lignes manquantes, qu'il faut **dire**.

## Décision

1. **Plus de rollback, et on poursuit le lot.** Un refus non rattrapable (pas de joker
   applicable, ADR-024) est **consigné** et la boucle continue avec les lignes suivantes. Aucune
   réservation déjà passée n'est annulée. `cancel_reservation` n'est plus appelé par le pipeline.
2. **Les refus sont portés par l'état du graphe** (`reservationFailures: ReservationFailure[]`,
   `state.ts`) : créneau, court, joueurs, code de refus resa-squash (`reason`), motif lisible
   (`message` — le message TeamR quand resa-squash le transmet, ex. « X a utilisé tous ses
   crédits… »), et texte brut (`rawError`). Ils figurent aussi dans le `detail` de l'événement
   `announced`.
3. **Tout l'aval raisonne sur « réellement réservé » = proposé − hors fenêtre − refusé**
   (`reservedBookings()`, exportée par `announce.ts`) : annonce WhatsApp, QR d'accès (ADR-026),
   synthèse, rappel J+1 et UI. Un court refusé n'est jamais présenté comme pris.
4. **Chaque canal reçoit le niveau de détail qui lui revient** (même principe qu'ADR-016) :
   - **WhatsApp** (annonce) : les courts pris, puis un bloc « ⚠️ Non réservé : 19H30-20H15
     (court 2) — motif lisible ». Jamais le JSON MCP.
   - **Telegram** (organisateur) : le message « Annonce envoyée … » liste chaque refus avec le
     code de refus et le texte brut.
   - **UI étape 4** : sous l'annonce, la liste des refus avec le code et le brut en repli.
5. **Si aucune ligne n'a pu être réservée**, comportement historique conservé : l'erreur
   d'origine est relancée, l'étape 4 est en échec (relançable), le groupe reçoit le message
   générique « aucun court n'a été réservé ».

## Conséquences

- Un job auto peut désormais se terminer en `finished-announced` avec des lignes manquantes ; il
  n'y a **pas** de bouton « Relancer » dans cet état (réservé aux échecs). Retenter les lignes
  refusées se fait manuellement (resa-squash) ou via un nouveau job manuel.
- Les refus ne sont **pas** retentés automatiquement plus tard.
- Le message WhatsApp d'échec total reste inchangé pour le cas « rien réservé ».
- L'ADR-014 (rollback best-effort) et l'ADR-024 (« les deux refusés → rollback du lot ») sont
  amendées par la présente : le refus reste un refus, mais **de la ligne seule**.
- Piste ouverte, non traitée ici : vérifier les crédits du joker au moment du plan pour ne pas
  le proposer sur un créneau qu'il ne peut pas tenir (cause première de l'incident).
