# ADR-026 – QR d'accès au club envoyé dans le groupe WhatsApp

**Status:** accepted
**Date:** 2026-09-07

## Contexte

Le QR code qui ouvre la porte du club est produit par TeamR et récupéré par resa-squash. Depuis
son plan « QR code notifications », resa-squash l'envoie déjà tout seul, en asynchrone, après
chaque réservation faite via son API : job différé (~5 s) → URL signée → Telegram, ntfy et
WhatsApp via NATS.

Ce QR n'arrivait pourtant jamais dans les groupes de joueurs. Le relais WhatsApp de ce flux
(huddle-bot, `apps/listener/src/nats-subscriber.ts`) n'a **qu'une seule destination**, la
variable d'environnement `SQUASH_GROUP_JID` — en pratique un canal d'observation. Or
squash-assistant sert plusieurs règles pointant chacune vers un groupe WhatsApp différent
(`squashacademie-mardi`, `squash-samedi-matin`, `test-vincent-all`) : un JID global ne peut pas
router correctement, et repointer la variable enverrait en prime le digest texte natif de
resa-squash en doublon de l'annonce squash-assistant.

Deux options ont été comparées le 2026-09-06 :

- **A** — repointer `SQUASH_GROUP_JID` et ajouter un drapeau « QR seulement » dans huddle-bot.
  Écartée : une seule destination pour toutes les règles, et le QR partirait hors du contrôle
  du pipeline (destinataire de test `reservationNotifyWhatsappGroupJid` ignoré, dry-run inclus).
- **B** — retenue : squash-assistant demande le QR et l'envoie lui-même.

## Décision

**squash-assistant envoie le QR, en réutilisant deux tools MCP créés pour l'occasion** — il ne
génère ni ne stocke jamais d'image.

1. **resa-squash `get_booking_qr({ sessionId })`** → `{ url, expiresAt, caption, qrAvailable }`.
   Extrait du job différé existant (`buildQrLinkForSession`), donc une seule implémentation de
   la chaîne QR TeamR → cache Redis → token HMAC signé. Scope **READ_WRITE** exigé et accès
   restreint aux membres du groupe de la réservation ou aux joueurs de la paire : le QR ouvre
   une porte, ce n'est pas une donnée de lecture anodine.
2. **huddle-bot `send_image({ jid, imageUrl, caption })`** → `WhatsAppClient.sendImage`, qui
   existait déjà pour le relais NATS mais n'était pas exposé en MCP. URL http(s) uniquement :
   c'est le listener qui télécharge l'image (WhatsApp étant chiffré de bout en bout, ses
   serveurs ne peuvent pas la chercher), l'endpoint ne doit pas devenir un fetcher universel.
3. **Ici** : `apps/worker/src/graph/bookingQr.ts` — un QR par court, celui du créneau le plus
   tôt (même règle que resa-squash : le court ouvert le reste pour les créneaux suivants),
   envoyé au JID de la règle après l'annonce (étape 4) et rejoué dans le rappel J+1.

### L'URL est demandée à l'envoi, jamais conservée

Le lien vit une dizaine de minutes : passé ce délai le token HMAC expire *et* la clé de cache
Redis a disparu. C'est délibéré côté resa-squash (le QR est un credential d'accès), et ça
détermine la forme du code ici : pas de champ en base, pas de réutilisation d'un lien d'hier.
Le rappel J+1 rappelle simplement `get_booking_qr`, qui refabrique tout à partir du `sessionId`.

### Best-effort, toujours

Un QR manquant n'est jamais une erreur du pipeline : l'annonce et le rappel sont déjà partis
quand on tente l'envoi, et chaque court échoue indépendamment (aucun token TeamR actif côté
resa-squash, TeamR muet, envoi WhatsApp refusé) sans interrompre les autres. Le QR reste par
ailleurs récupérable dans l'application resa-squash.

### Uniquement sur réservation réelle

En dry-run, rien n'est réservé : aucun QR n'est demandé ni envoyé.

## Conséquences

- Le groupe reçoit, après l'annonce, une image par court réservé, légendée par resa-squash
  (`Court 3 — samedi 12 septembre, 10H30`) — même légende que les autres canaux.
- Nouvelle dépendance de squash-assistant à deux tools MCP : un serveur trop ancien fait
  simplement échouer l'appel, qui est déjà rattrapé (best-effort). Aucune migration.
- La clé MCP huddle-bot doit être `READ_WRITE` (elle l'est déjà : elle envoie les sondages), et
  la clé resa-squash aussi (elle l'est déjà : elle réserve).
- Le flux NATS de resa-squash reste en place et inchangé : les deux canaux coexistent, comme
  aujourd'hui, mais ne visent pas les mêmes groupes.
