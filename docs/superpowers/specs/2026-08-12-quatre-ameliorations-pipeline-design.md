# Design — 4 améliorations du pipeline (rappel J+1, collecte 23h30, synthèse test, cascade joueur seul)

Date : 2026-08-12
Statut : validé par l'utilisateur, en attente de plan d'implémentation.

## Contexte

Quatre demandes indépendantes touchant le scheduler (`apps/worker/src/scheduler/`), le nœud
`announce` (`apps/worker/src/graph/nodes/announce.ts`) et le moteur de plan local
(`apps/worker/src/planning/planJob.ts`). Regroupées dans un seul design car elles partagent le
même terrain (BookingRule, JobRun, pipeline LangGraph) mais restent 4 changements indépendants,
implémentables et review-ables séparément.

---

## 1. Rappel J+1 (nouvelle étape optionnelle)

**Besoin** : envoyer un message de rappel dans le groupe WhatsApp du sondage, le lendemain de la
date du match (`targetDate + 1`), vers 0h05-0h10 (± quelques minutes). Activable/désactivable par
règle.

**Schéma**
- `BookingRule.nextDayReminderEnabled: boolean` (défaut `false`) — nouvelle colonne
  `booking_rules.next_day_reminder_enabled`, migration Drizzle.
- `JobRun.nextDayReminderSentAt: Date | null` — nouvelle colonne
  `job_runs.next_day_reminder_sent_at`, migration Drizzle. Garde-fou anti-doublon (redémarrage du
  pod, plusieurs ticks) — même rôle que les autres champs d'état de job déjà en place.

**Scheduling**
- Nouveau cron **par règle enabled**, non éditable par l'utilisateur (contrairement à
  `pollCron`/`decisionCron`), fixé à `05 0 * * *` (Europe/Paris) + jitter de 10 min via
  `scheduleWithCronJitter` (mécanisme déjà utilisé pour poll/decision) → fenêtre effective
  ~00h05-00h15, couvrant la demande "0h05-0h10 ± 5-10min".
- Enregistré/désenregistré dans `cronRegistry.ts` au même endroit que `pollTask`/`decisionTask`
  (`scheduleOne`, `clearRuleHandles`, `reloadScheduler`).

**Déclenchement (`scheduler.ts`, nouvelle fonction `triggerNextDayReminder`)**
1. Relit la règle fraîche (comme `onPoll`/`onDecision`) ; si `nextDayReminderEnabled` est faux ou
   la règle désactivée → no-op silencieux.
2. Calcule `targetDate = hier` (Europe/Paris) et cherche le(s) job(s) actif(s) de la règle pour
   cette date (réutilise le pattern de `findActiveJobRunForDate`, adapté pour ne pas filtrer sur
   "actif aujourd'hui" mais sur la date exacte).
3. Pour chaque job trouvé : si `nextDayReminderSentAt` déjà renseigné → skip. Sinon,
   `getJobExecutionStatus` ; si `stage !== "finished-announced"` → skip sans erreur (pas
   d'annonce à rappeler). Sinon, récupère `status.values.announceMessage` (déjà stocké dans
   `PipelineStateType`, retourné par `createAnnounceNode`) et le renvoie tel quel via
   `sendMessage(huddleBot, rule.whatsappGroupJid, announceMessage)`.
4. Marque `nextDayReminderSentAt = now()` en DB, log Telegram (`[ruleId] Rappel J+1 envoyé pour
   le <targetDate>.`).

**Pas de nouveau nœud LangGraph** — ce rappel est hors pipeline, comme un job cron indépendant
qui relit un état déjà terminé.

---

## 2. Collecte des votes à 23h30 sans décalage aléatoire

**Besoin** : la collecte des votes (`decisionCron`) doit se déclencher pile à l'heure configurée,
sans le flou `cronJitterWindowMinutes` actuellement partagé avec `pollCron`.

**Changement** — global, toutes règles, pas de nouveau champ :
- `cronRegistry.ts` : la branche `decisionTask` n'appelle plus `scheduleWithCronJitter` — elle
  invoque `rt.onDecision(fresh)` directement au déclenchement du cron.
- `pollTask` conserve le jitter existant (`scheduleWithCronJitter` avec
  `cronJitterWindowMinutes`).
- `cronJitterWindowMinutes` (nom de champ inchangé) documente désormais qu'il s'applique
  uniquement à `pollCron` — mise à jour du commentaire dans `packages/db/src/schema.ts` et de
  `docs/spec/regles-fonctionnelles.md` (§ "Flou horaire des crons auto").

**Hors code** : passer la règle concernée à `decisionCron = "30 23 * * *"` est une édition de
donnée (UI), pas un changement de code — à faire après déploiement.

---

## 3. Synthèse votes/réservations vers le groupe de test

**Besoin** : dans le groupe WhatsApp de test (`reservationNotifyWhatsappGroupJid`), envoyer en
plus du message d'annonce actuel une synthèse : qui a voté à chaque heure, ce qui a été réservé,
et pourquoi le reste ne l'a pas été.

**Changement** — `announce.ts`, `createAnnounceNode` :
- Après l'envoi du message d'annonce existant (inchangé, part toujours vers `notifyJid` résolu
  par `resolveAnnounceNotifyJid`), un **second message** est envoyé, uniquement si
  `bookingRule.reservationNotifyWhatsappGroupJid` est configuré (non vide) — c'est-à-dire
  uniquement en "mode test" avec un groupe distinct du groupe de sondage. Si le champ est vide
  (annonce sur le groupe réel), pas de second message.
- Contenu construit à partir de données déjà calculées dans le state, aucun nouveau calcul
  métier :
  - Par heure candidate (`bookingRule.candidateStartTimes` ∩ heures ayant au moins un vote,
    même filtre que la règle d'affichage 2026-07-19) : liste des joueurs confirmés
    (`confirmedPlayerIdsByTime`).
  - Pour chaque `BookingPlanGroup` : créneaux effectivement proposés (`plan.proposedBookings`)
    et, si `plan.proposedBookings` est vide ou incomplet, les `plan.warnings` correspondants
    (raison : effectif insuffisant, plafond TeamR, hors fenêtre, etc. — déjà du texte prêt à
    l'emploi, pas de nouvelle classification de raisons).
- Nouvelle fonction pure `buildVoteBookingSynthesis(bookingRule, targetDate,
  confirmedPlayerIdsByTime, bookingPlanGroups)` (proche de `announce.ts`, testable isolément).

---

## 4. Cascade "joueur seul → heure suivante"

**Besoin** : un joueur seul (aucun partenaire) sur une heure candidate est considéré disponible
sur l'heure candidate suivante — jamais l'inverse. Un joueur avec un partenaire à son heure garde
son heure d'origine.

**Portée** (décidée avec l'utilisateur) :
- Déplacement, pas duplication : le joueur seul est retiré de son heure d'origine et ajouté à
  l'heure candidate immédiatement suivante.
- Une seule heure de cascade (pas de transitivité au-delà de l'heure suivante immédiate).
- Comportement global (pas d'option par règle).

**Implémentation** — `planJob.ts`, nouvelle fonction pure `cascadeSoloVotersForward` :
- Exécutée sur `confirmedPlayerIdsByTime` **avant** `applyUnexpectedPlayersMargin` et avant la
  boucle principale de `planJobBookings` (la cascade doit porter sur les votes réels, pas sur les
  joueurs de marge ajoutés ensuite).
- Pour chaque heure candidate (dans l'ordre de `bookingRule.candidateStartTimes`, sauf la
  dernière) : si elle a **exactement 1** joueur confirmé, celui-ci est retiré de cette heure et
  ajouté à la liste de l'heure candidate suivante.
- Une heure vidée par ce déplacement (0 confirmé) est ensuite naturellement masquée par la règle
  d'affichage existante (2026-07-19, `regles-fonctionnelles.md` L61) — aucun changement UI requis.
- Ne modifie pas la logique existante de fusion tardif→précédent (`findMergeableSession`,
  2026-08-05) : cas différent (rejoindre une session déjà **ouverte** après planification, pas un
  déplacement de vote avant toute planification). Les deux règles sont complémentaires et
  s'appliquent à des moments différents du pipeline.

**Cas non couvert (volontairement)** : si l'heure suivante devient à son tour seule (1 joueur)
après la cascade, elle n'est pas re-cascadée vers l'heure d'après (portée limitée à un seul saut,
décision utilisateur).

---

## Documentation à mettre à jour dans la même PR

- `docs/spec/regles-fonctionnelles.md` :
  - Nouvelle entrée pour le rappel J+1 (§ étapes du pipeline / options par règle).
  - Mise à jour de la ligne "Flou horaire des crons auto" (jitter poll uniquement).
  - Nouvelle entrée pour la synthèse groupe de test (§ étape Announce).
  - Nouvelle entrée pour la cascade joueur seul (§ moteur de plan, proche de la règle fusion
    tardif→précédent 2026-08-05).
  - Tableau chronologique des règles (bas de fichier) : une ligne par changement.
- Pas de nouvel ADR — aucune de ces 4 modifications ne change une décision d'architecture
  actée (framework, persistance, délégation MCP) ; ce sont des règles fonctionnelles et un ajout
  de cron suivant un pattern déjà en place.

## Tests

- `cronRegistry.test.ts` (ou équivalent) : jitter appliqué à poll, pas à decision ; nouveau cron
  reminder enregistré/désenregistré avec la règle.
- `scheduler.test.ts` : `triggerNextDayReminder` — cas job absent, déjà envoyé, pas encore
  annoncé, cas nominal.
- `planJob.test.ts` : cascade joueur seul (déplacement simple, pas de cascade si partenaire
  présent, pas de transitivité au-delà d'un saut, dernière heure candidate non cascadée).
- `announce.test.ts` : second message envoyé seulement si `reservationNotifyWhatsappGroupJid`
  configuré ; contenu de synthèse correct (votes vs réservé vs raison).
