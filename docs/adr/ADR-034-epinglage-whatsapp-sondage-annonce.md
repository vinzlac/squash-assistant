# ADR-034 – Épinglage WhatsApp du sondage puis de l'annonce

**Status:** accepted
**Date:** 2026-10-03

## Contexte

huddle-bot a ajouté deux tools MCP d'écriture, `pin_message` / `unpin_message` (épinglage pour
tous les membres, `PIN_FOR_ALL`/`UNPIN_FOR_ALL`, visible dans le WhatsApp natif de chacun ;
durée `24h`/`7d`/`30d` ; marche sans être admin du groupe — voir huddle-bot
[ADR-010](../../../huddle-bot/docs/adr/ADR-010-mcp-server-openclaw-dans-apps-ui.md), amendement
2026-10-02).

Le sondage hebdomadaire et l'annonce des courts réservés se noient vite dans l'activité d'un
groupe WhatsApp actif — les joueurs doivent remonter l'historique pour retrouver quoi voter ou
quels courts sont pris. Épingler ces deux messages (et seulement eux, et seulement tant qu'ils
sont pertinents) règle ce problème sans rien ajouter côté huddle-bot : squash-assistant pilote
entièrement le cycle épingler/désépingler depuis le pipeline.

## Décision

Un réglage par règle, **`BookingRule.pinMessagesEnabled`** (défaut `false`), active :

1. **Sondage (étape 1)** : épinglé pour 7 jours dès l'envoi. Le message « PUC fermé » envoyé à
   sa place n'est jamais épinglé.
2. **Collecte (étape 2)** : le sondage est désépinglé dès que les votes sont lus — qu'ils ne
   soient plus d'actualité une fois collectés.
3. **Annonce (étape 4)** : l'annonce principale (dry-run compris) est épinglée pour 7 jours sur
   le groupe de notification. Son `msgId`/JID sont mémorisés sur le job
   (`job_runs.announce_msg_id` / `announce_jid`) — ni les QR, ni la synthèse, ni le message
   d'échec total ne sont épinglés.
4. **Sondage suivant** : avant d'envoyer son propre sondage, chaque job commence par désépingler
   l'annonce du job précédent de la même règle (même si le PUC est fermé ce coup-ci) et l'oublie
   sur ce job si le désépinglage a réussi.

Le point 4 **ne dépend pas de la case** : une règle désactivée entre-temps nettoie quand même ce
qu'elle avait épinglé — c'est un ménage, pas une fonctionnalité qu'on peut couper en cours de
route. La durée de 7 jours n'est qu'un filet (WhatsApp retire l'épinglage de lui-même si plus
aucun sondage ne part derrière).

### Best-effort, toujours

Même principe que le QR d'accès (ADR-026) : un épinglage ou un désépinglage qui échoue ne fait
jamais échouer l'étape — le sondage ou l'annonce est déjà partie. Signalé sur Telegram
(`[règle] Épinglage/Désépinglage … échoué : …`), jamais sur WhatsApp. Un sondage supprimé
(annulation manuelle, fermeture PUC tardive) perd son épinglage avec lui : rien à désépingler
dans ce cas.

### Lu sur l'instantané de la règle, comme le reste du pipeline

La case est lue sur la copie de la règle prise par chaque job (comme `requireTelegramGoForAutoJobs`
ou `nextDayReminderEnabled`) : l'activer prend effet au **prochain** sondage, pas sur un job déjà
en cours.

## Conséquences

- Nouvelle colonne `booking_rules.pin_messages_enabled` (défaut `false`) et deux colonnes
  `job_runs.announce_msg_id` / `announce_jid` (migration `0030_pin_messages.sql`).
- `huddleBot.sendMessage` renvoie désormais `{ msgId }` (huddle-bot le fournissait déjà depuis le
  2026-09-14, cf. huddle-bot ADR-010) — les appelants existants qui ignoraient le retour ne
  changent pas de comportement.
- Nouveau module `apps/worker/src/graph/pinning.ts` (`pinBestEffort`/`unpinBestEffort`) partagé
  par `sendPoll.ts`, `collectVotes.ts` et `announce.ts`.
- La clé MCP huddle-bot doit être `READ_WRITE` (elle l'est déjà : elle envoie les sondages).
- Aucun changement côté resa-squash. Aucun changement de comportement pour les règles qui ne
  cochent pas la case (défaut sur toutes les règles existantes).

## Références

- Règle fonctionnelle détaillée : [`docs/spec/regles-fonctionnelles.md`](../spec/regles-fonctionnelles.md) §6.
- huddle-bot ADR-010, amendement 2026-10-02 (tools `pin_message`/`unpin_message`).
- [ADR-026](./ADR-026-qr-acces-club-dans-whatsapp.md) — même principe de best-effort pour une
  interaction WhatsApp annexe à l'annonce.
