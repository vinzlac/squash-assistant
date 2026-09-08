# TODO — vérifier le QR d'accès dans WhatsApp (après la réservation auto du mardi)

**Créé le 2026-09-08**, à exécuter après le premier job de réservation **réelle** suivant le
déploiement de [ADR-026](../adr/ADR-026-qr-acces-club-dans-whatsapp.md) (commit `5125136`,
poussé le 2026-09-08 ; nécessite resa-squash `044aaee` et huddle-bot `d9f590b`).

Contexte complet : ADR-026 et la règle « QR d'accès au club dans le groupe » de
[`docs/spec/regles-fonctionnelles.md`](../spec/regles-fonctionnelles.md) §6.

## Ce qui est attendu

- [ ] Le groupe WhatsApp de la règle reçoit l'annonce habituelle, **puis une image de QR code
      par court réservé** — un seul par court, celui du créneau le plus tôt.
- [ ] Chaque image porte une légende du type `Court 3 — mardi 8 septembre, 18H45`
      (produite par resa-squash, identique à ses autres canaux).
- [ ] Le **rappel J+1** (lendemain ~00h05 + jitter) affiche le format court :
      `🔔 Rappel — Réservation pour <jour>`, date, courts fusionnés, votes par heure — **sans**
      nom de règle, prête-noms, mention « automatiquement » ni phrase de clôture.
- [ ] Le rappel J+1 renvoie **aussi** les QR (liens régénérés, ceux de la veille ont expiré).
- [ ] Dans le plan Telegram de l'étape 3, le joker apparaît par son **nom**, plus par son
      userId brut (`60ca2a7d…`).

## Si quelque chose manque

1. **Le pod worker tournait-il avec la nouvelle image ?** Si le déploiement CI n'était pas
   terminé à l'heure du `decisionCron`, le comportement est celui d'avant — sans erreur.
   Vérifier l'image du pod worker avant de chercher plus loin.
2. **Réservation réelle ou dry-run ?** Aucun QR n'est envoyé si `dryRun !== false` : rien n'est
   réservé, donc rien à ouvrir.
3. **Logs du worker, préfixe `[qr]`** (`apps/worker/src/graph/bookingQr.ts`) :
   - `console.warn` « Aucun QR disponible » → resa-squash a répondu `qrAvailable: false`,
     c'est-à-dire qu'aucun joueur de la paire n'a de token TeamR actif
     (`user_teamr_tokens` : le token n'est rafraîchi qu'au login sur resa-squash). Cas le plus
     probable, et normal.
   - `console.error` → l'appel lui-même a échoué : tool MCP absent (déploiement resa-squash ou
     huddle-bot en retard), TeamR muet, ou envoi WhatsApp refusé.
4. **Rien dans les logs du tout** → le code n'est pas passé par là : vérifier `realBooking` et
   que la branche QR de `announce.ts` est bien dans l'image déployée.

## Notes

- Tout est **best-effort** : un QR manquant ne fait jamais échouer l'annonce ni le rappel, qui
  sont déjà partis quand l'envoi est tenté. Le QR reste récupérable dans l'app resa-squash.
- Le flux NATS historique de resa-squash continue en parallèle d'envoyer les QR vers le canal
  `SQUASH_GROUP_JID` (« assistant resa squash ») — ce n'est pas un doublon du groupe joueurs.
- Pour rejouer un essai sans attendre un mardi : réservation réelle sur la règle
  `test-vincent-all`, dont l'annonce et les QR partent dans le groupe de test.

## Une fois vérifié

Supprimer ce fichier (ou le remplacer par un post-mortem dans `docs/post-mortem/` si quelque
chose s'est mal passé).
