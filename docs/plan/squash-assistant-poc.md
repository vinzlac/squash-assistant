# Plan — Orchestrateur agent squash (POC)

**Date** : 2026-07-11
**Statut** : proposé, pas démarré
**Destination** : ce document est écrit pour être copié tel quel dans un **nouveau repo séparé** (`squash-assistant`) qui n'aura pas accès au code/mémoire de huddle-bot ni de resa-squash. Il est donc volontairement autoporteur : tous les détails techniques nécessaires (endpoints, schémas de tools, auth) sont inlinés ci-dessous plutôt que renvoyés vers des ADR externes.

---

## 1. Vision / Contexte

**⚠️ Ce n'est pas un assistant conversationnel.** squash-assistant n'a **pas d'UI**, ne reçoit pas de prompt libre d'un utilisateur, et n'interprète pas de demande ad hoc. C'est un **pipeline automatisé déclenché par le temps** qui **remplace la personne qui gère aujourd'hui les réservations manuellement** (sondage WhatsApp, lecture des votes, réservation, annonce), selon un processus fixe en 4 étapes, répété chaque semaine par groupe :

1. **À l'heure T** (jour/heure configurables par groupe) : envoyer un sondage WhatsApp au groupe ("qui veut jouer la semaine prochaine ?") via le MCP huddle-bot (`ask_poll`) — **+ log Telegram**.
2. **Un peu avant le soir de ce même jour** : récupérer les réponses (`get_responses` — huddle-bot classifie déjà oui/non/ambigu via LLM côté serveur, rien à réinterpréter ici) pour déterminer qui veut jouer — **+ log Telegram**.
3. **À une heure donnée** (variable selon le jour/groupe, cf. config à définir — voir §8) : réserver pour **J+7** les créneaux nécessaires pour les personnes ayant répondu favorablement, selon les règles métier déjà définies dans le skill de l'agent OpenClaw existant (`plan_group_bookings`, cf. §2.2) — **dry-run → confirmation "go" sur Telegram → `reserve_slot`** — **+ log Telegram**.
4. **Informer le groupe WhatsApp** des créneaux pris, en **regroupant les créneaux adjacents** pour plus de clarté dans le message (règle de présentation, cf. §8) — **+ log Telegram**.

Chaque étape logue son résultat sur Telegram, que l'étape ait réussi, échoué, ou soit en attente de confirmation — c'est le seul canal de supervision du POC (pas d'UI).

**Ce n'est pas un besoin nouveau** : **OpenClaw**, un agent déjà en prod, joue aujourd'hui un rôle équivalent (déclenché par crons natifs) consommant ces deux mêmes serveurs MCP, sur exactement le même processus en 4 étapes.

**⚠️ Recouvrement connu, coexistence assumée** : le repo `k3s-homelab` contient `docs/plan/plan-squash-auto-openclaw-whatsapp.md`, qui vise **le même objectif métier** (sondage WhatsApp → lecture des votes → réservation resa-squash → annonce, avec validation humaine) mais via **OpenClaw + crons natifs** plutôt qu'un nouveau service LangGraph. Ce plan est partiellement fait (infra Postgres huddle-bot ✅, reste de l'agent OpenClaw 🔲 TODO). **Décision (2026-07-12) : ce plan OpenClaw n'est pas touché, ne devient pas obsolète et n'est pas fusionné avec squash-assistant.** squash-assistant est une **expérimentation séparée qui coexiste en parallèle** — une manière alternative d'implémenter le même processus (moteur LangGraph.js + scheduler interne, plutôt que crons OpenClaw natifs), à évaluer indépendamment (voir Phase 4, §7). Les deux peuvent avancer chacun de leur côté sans dépendance ni blocage mutuel. Les noms de tools MCP huddle-bot listés dans le plan OpenClaw (`list_whatsapp_groups`, `get_latest_poll`, `create_poll`, etc.) sont **obsolètes par rapport à l'implémentation réelle** — voir §2.1 pour les noms réels effectivement déployés. Les règles métier de réservation (`AGENTS.md`, `skills/resa-squash-group-booking.md` du workspace OpenClaw squash, cf. `k3s-homelab/scripts/openclaw-context/squash/`) sont la référence à répliquer pour les étapes 3 et 4 — voir §2.2 et §8.

**squash-assistant ne réinvente pas la logique d'allocation des créneaux** (déjà dans `plan_group_bookings` côté resa-squash, cf. §2.2) ni l'interprétation des votes (déjà dans `get_responses` côté huddle-bot, cf. §2.1). Ce qui reste propre à squash-assistant : le **déclenchement temporel** (scheduler par groupe), l'**enchaînement** des 4 étapes avec passage d'état entre elles, la **validation humaine** avant réservation, et le **formatage de l'annonce finale** (regroupement des créneaux adjacents).

---

## 2. Systèmes externes à consommer

### 2.1 MCP huddle-bot (WhatsApp)

Serveur MCP qui expose des tools d'exécution WhatsApp — pas d'intelligence, pas de décision, purement des actions.

| Élément | Valeur |
|---------|--------|
| URL MCP prod | `https://huddle-bot.code-advisors.site/api/mcp` |
| Transport | `streamable-http` |
| Authentification | Header `Authorization: Bearer sk_live_...` (clé API applicative) |
| Accept | `application/json, text/event-stream` |

**⚠️ Piège connu** : `huddle-bot.code-advisors.site` est normalement derrière `oauth2-proxy` (Google OAuth) sur l'ingress. Une route Ingress dédiée, plus spécifique que `/`, a déjà été mise en place côté huddle-bot pour que `/api/mcp` court-circuite `oauth2-proxy` (sinon la requête reçoit systématiquement "No authorization provided" même avec une clé API valide). Si la connexion MCP échoue avec une erreur d'auth malgré une clé valide, vérifier côté huddle-bot que cette route Ingress existe toujours (elle est documentée dans son repo sous `docs/post-mortem/2026-07-07-mcp-api-oauth2-proxy-bypass.md` et `docs/adr/ADR-010-*.md`).

**Tools exposés :**

| Tool | Rôle | Paramètres | Scope requis |
|------|------|------------|---------------|
| `list_groups` | Liste les groupes WhatsApp connus (JID, nom) — à utiliser pour découvrir un `groupJid` | *(aucun)* | Lecture (aucun scope requis) |
| `ask_poll` | Envoie un sondage natif Oui/Non dans un groupe | `groupJid: string`, `question: string` | **READ_WRITE** |
| `ask_question` | Envoie une question texte libre dans un groupe | `groupJid: string`, `question: string` | **READ_WRITE** |
| `get_responses` | Retourne le statut (oui/non/ambigu/aucune_réponse) de chaque membre à un sondage/question | `requestId: string` | Lecture |
| `send_message` | Envoie un message texte simple dans un groupe/chat | `jid: string`, `text: string` | **READ_WRITE** |

Chaque appel renvoie un contenu texte (résumé) + `structuredContent` (JSON). Une erreur renvoie `{ isError: true, content: [...] }`.

**Obtenir une clé API** : côté huddle-bot, un script (`packages/db/scripts/create-mcp-api-key.ts`) génère une clé `sk_live_...` avec un scope (`READ_WRITE` ou `READ_ONLY`) et un label optionnel. La clé en clair n'est affichée qu'une fois à la création (hashée en DB ensuite) — la demander à l'opérateur de huddle-bot, ou si tu as accès au repo huddle-bot : `pnpm --filter db exec tsx scripts/create-mcp-api-key.ts READ_ONLY squash-assistant-poc`.

Pour le POC, une clé **`READ_ONLY`** suffit tant qu'aucune action d'écriture réelle (poll, message) n'est nécessaire — privilégier la lecture (`list_groups`, `get_responses`) et simuler/logguer les actions d'écriture plutôt que les exécuter, ou demander une clé `READ_WRITE` scope dédiée et clairement labellisée si le POC doit réellement écrire dans le groupe de test.

### 2.2 MCP resa-squash (réservation)

Serveur MCP de réservation de courts de squash, connecté à l'API du club (TeamR) en interne.

| Élément | Valeur |
|---------|--------|
| URL MCP prod | `https://resa-squash.vercel.app/api/mcp` |
| Transport | `streamable-http` |
| Authentification | Header `Authorization: Bearer sk_live_...` (clé API) |
| Accept | `application/json, text/event-stream` |
| App web (pour créer une clé) | `https://resa-squash.vercel.app/settings/api-key` (après login sur `/login`) |

Scopes : **`READ_ONLY`** (consultation, planification en dry-run) ou **`READ_WRITE`** (en plus `reserve_slot`/`cancel_reservation`).

**Tools exposés :**

| Tool | Rôle | Scope |
|------|------|-------|
| `server_info` | Version déployée, horloge UTC/Paris, environnement | Lecture |
| `list_availability` | Créneaux libres (`dateFrom`/`dateTo`, max 31 j, option `courts` 1–4) | Lecture |
| `list_my_favorites` | Favoris (prénom, nom, `userId`) | Lecture |
| `list_my_groups` | Groupes dont l'utilisateur est membre (`groupId`, récurrence, quotas) | Lecture |
| `list_group_members` | Membres d'un groupe ; option `includePhones: true` → téléphone E.164 | Lecture |
| `lookup_player_by_phone` | Corrèle un numéro WhatsApp → joueur (`found`, `userId`, `firstName`, `lastName`) | Lecture |
| `list_my_reservations` | Réservations (filtre `fromDate` optionnel) | Lecture |
| `list_my_reservations_on_date` | Réservations un jour donné (`onDate`, `timeZone`) | Lecture |
| `list_reservations_for_group_on_date` | Réservations liées à un `groupId` un jour donné | Lecture |
| `plan_group_session` | Planning 2v2 déterministe (sans réservation) | Lecture |
| `plan_group_bookings` | Plan multi-courts groupe — **`dryRun: true` par défaut** | Lecture (écriture seulement si `dryRun: false`) |
| `reserve_slot` | Réserve un créneau (2 joueurs + `groupId` optionnel) | **READ_WRITE** |
| `cancel_reservation` | Annule une réservation | **READ_WRITE** |

**Règles métier utiles pour le prompt système de l'agent :**
- Fuseau par défaut : **Europe/Paris**.
- Ne jamais inventer un `sessionId`/`userId` — toujours issus d'un appel MCP précédent (`list_availability`, `list_my_favorites`, etc.). Si `lookup_player_by_phone` renvoie `found: false`, ne pas inventer d'identité.
- Créneaux de **45 min**, **4 courts**, **2 joueurs** par réservation.
- Nombre de terrains nécessaires = `ceil(nb_joueurs / 3)`, généralement **2–3 créneaux par joueur**, **quota de 2 réservations/jour** par joueur — ces règles sont déjà implémentées côté `plan_group_bookings`, rien à recoder dans l'agent.
- Si effectif impair sans partenaire : le dernier joueur passe en **rotation** (champ `meta.rotatingPlayerIds` de `plan_group_bookings`) — à afficher clairement dans le récap plutôt qu'à masquer.
- Flow réservation groupe typique : `list_my_groups` → `list_group_members` + `list_my_favorites` → `list_availability` → `plan_group_bookings` (`dryRun: true`) → validation humaine → `reserve_slot` pour chaque ligne retenue.

**Pour le POC : toujours appeler `plan_group_bookings` avec `dryRun: true` et ne jamais appeler `reserve_slot` / `cancel_reservation`** (nécessitent `READ_WRITE`, hors scope du POC — préférer une clé `READ_ONLY` pour resa-squash aussi).

**Pattern de validation humaine à reprendre** (déjà éprouvé sur l'agent OpenClaw squash existant, cf. §9) : le Superviseur prépare le plan de réservation en dry-run, l'envoie en clair sur le canal Telegram du POC, **attend une confirmation explicite ("go") avant toute action d'écriture**. Pour le POC (scope `READ_ONLY` partout), cette étape s'arrête théoriquement à l'envoi du plan — mais la structurer dès maintenant comme un nœud `interrupt()` dans le graphe (plutôt qu'un simple log) prépare la phase où le scope deviendrait `READ_WRITE`.

### 2.3 Telegram (log + validation humaine)

Le POC a besoin d'un canal pour rapporter ce que fait chaque étape **et** pour recueillir la confirmation humaine ("go") avant réservation (étape 3, §1). **Ne pas réutiliser le système Telegram de resa-squash tel quel** : celui-ci est un système de liaison compte-utilisateur (chaque utilisateur lie son propre chat Telegram à son compte resa-squash via un flow `/start` + token de liaison, pensé pour des notifications personnelles de réservation) — pas un canal générique de log + confirmation.

**Pour le POC, créer un bot Telegram dédié et simple :**
1. Créer un bot via [@BotFather](https://t.me/BotFather) → récupérer `TELEGRAM_BOT_TOKEN`.
2. Créer un chat/groupe Telegram privé dédié au POC, y ajouter le bot, récupérer le `chat_id` (via `getUpdates` après avoir envoyé un message test, ou via un bot comme @userinfobot pour un groupe).
3. **Sortant** : envoyer les messages de log via l'API Telegram HTTP (`POST https://api.telegram.org/bot<TOKEN>/sendMessage` avec `chat_id` + `text`).
4. **Entrant (nouveau — nécessaire pour la confirmation "go")** : contrairement à ce qui avait été envisagé initialement (log pur, sans entrant), l'étape 3 doit **détecter la réponse humaine** ("go"/"non"/silence) après avoir envoyé le plan de réservation en dry-run. Utiliser le **long-polling** `GET https://api.telegram.org/bot<TOKEN>/getUpdates` (pas de webhook) — évite d'exposer un Ingress public pour ça, cohérent avec `publicHost: none` décidé en §5. Le nœud `interrupt()` du graphe (§4) reste en pause tant qu'aucun message "go" n'est détecté par le polling.

C'est volontairement plus simple que le système resa-squash — aucune notion de liaison compte/utilisateur n'est nécessaire ici, juste un aller-retour texte sur un chat fixe et connu à l'avance.

### 2.4 Bus d'events NATS (existant, pertinent post-POC uniquement)

Un bus d'events **NATS + JetStream** est déjà déployé sur le cluster K3s (namespace `nats`, cf. `plan-nats-event-bus-squash.md` du repo `k3s-homelab`) : quand resa-squash effectue une **vraie** réservation, il publie (ou publiera — la partie producteur côté resa-squash est encore TODO) un event `homelab.squash.reserved` sur `wss://nats.code-advisors.site`, consommé en fan-out par :
- **notif-consumer** (à créer) → Apprise → ntfy (self-hosté, déjà déployé) + Telegram
- **huddle-bot** (subscriber à ajouter) → message dans le groupe WhatsApp squash réel

**Pourquoi c'est pertinent pour squash-assistant, mais seulement plus tard :** si squash-assistant dépasse un jour le stade dry-run et se met à réellement appeler `reserve_slot`, il n'a **pas besoin** de gérer lui-même la notification WhatsApp/Telegram de confirmation de réservation — ce fan-out existe déjà et se déclenche automatiquement dès que `reserve_slot` réussit côté resa-squash. Ne pas dupliquer cette logique dans l'orchestrateur. Pour le POC actuel (dry-run, jamais `reserve_slot`), ce bus n'est pas sollicité — le canal Telegram dédié au POC (§2.3) reste le seul canal de sortie.

### 2.5 Config des groupes et horaires (clarifié le 2026-07-12)

**Deux groupes réels**, chacun associé à un groupe WhatsApp et un groupe resa-squash (`groupId`, `recurringWeekday`, `recurringStartTime` via `list_my_groups`) :

| Groupe | Jour cible | Créneaux à réserver | Sondage (T) | Collecte des votes | Décision de réservation |
|--------|-----------|----------------------|--------------|---------------------|--------------------------|
| **La squashacadémie** (mardi soir) | mardi (J+7 depuis le déclenchement) | terrain 2 = **18h45–21h**, terrains 3 & 4 = **19h30–21h** | mardi ~10h | mardi, un peu avant le soir | mardi ~21h30 |
| **Le squash du samedi matin** | samedi suivant | créneaux à partir de **10h30** | **même cycle que le mardi** (mardi ~10h / mardi ~21h30) | mardi, un peu avant le soir | mardi ~21h30 |

**Point clé** : les deux groupes partagent le **même cycle hebdomadaire de déclenchement** (sondage mardi ~10h, décision mardi ~21h30) — un seul scheduler/cron suffit pour les deux, mais chacun cible une **date de réservation différente** (mardi J+7 pour l'un, samedi suivant pour l'autre) et une **heure de créneau différente**. Le scheduler doit donc itérer sur la liste des groupes actifs à chaque déclenchement (mardi 10h → sondage des deux groupes ; mardi 21h30 → décision de réservation des deux groupes, chacun avec sa propre date/heure cible), plutôt que d'avoir un scheduler par groupe avec des horaires indépendants.

**Regroupement des créneaux adjacents (étape 4, Announce) — clarifié : présentation uniquement, pas la prise de réservation.** La réservation reste **unitaire** : un appel `reserve_slot` par créneau de 45 min, sans fusion côté écriture. La fusion ne s'applique **qu'au message WhatsApp final**, pour afficher "Court 2 : 18h45-20h15" au lieu de deux lignes séparées. L'algorithme exact existe déjà dans **resa-squash** (`app/utils/slot-merge.ts`, utilisé pour le partage UI et les notifications Telegram, cf. ADR-005 resa-squash) et doit être **porté tel quel** dans squash-assistant (~30 lignes, pas de dépendance) :

```ts
// Regroupe par court, trie par heure, fusionne si endTime(slot) === beginTime(slot suivant)
function mergeContiguousSlotsByCourt(
  bookings: Array<{ court: number; beginTime: string; endTime: string }>
): Array<{ court: number; beginTime: string; endTime: string }>

// "Court 2 : 18h45-20h15"
function formatMergedCourtSlots(slots: Array<{ court: number; beginTime: string; endTime: string }>): string
```

Pas de nouveau tool MCP resa-squash nécessaire pour ça — c'est une fonction pure, sans appel réseau, à réimplémenter côté squash-assistant à partir des `proposedBookings` déjà retournés par `plan_group_bookings`/`reserve_slot`.

**Schéma de config par groupe** (structuré, pas de règles en texte libre — voir §2.6 pour la discussion) :

```ts
interface GroupConfig {
  id: string                    // slug interne, ex. "squashacademie-mardi"
  enabled: boolean              // permet de tester sur un groupe et pas sur un autre sans redéployer
  whatsappGroupJid: string      // groupe WhatsApp huddle-bot (ex. groupe de test "Vincent All" pendant le POC)
  resaSquashGroupId: string     // groupId resa-squash (list_my_groups)
  pollCron: string              // ex. "0 10 * * 2" (mardi 10h, Europe/Paris)
  decisionCron: string          // ex. "30 21 * * 2" (mardi 21h30)
  targetWeekdayOffset: number   // jours entre le déclenchement et la date réservée (7 pour mardi→mardi, ~4 pour mardi→samedi)
  slotStartTimes: { court: number; beginTime: string }[]  // ex. [{court: 2, beginTime: "18H45"}, {court: 3, beginTime: "19H30"}, {court: 4, beginTime: "19H30"}]
}
```

Chaque nœud du graphe (§3) lit la `GroupConfig` du groupe concerné et branche dessus avec des conditions simples (`if groupConfig.targetWeekdayOffset === 7 ...`) — LangGraph n'a besoin d'aucune "compréhension" particulière, c'est de la donnée consommée par du code TS classique. Les 2 groupes réels (§2.5) rentrent intégralement dans ce schéma sans champ supplémentaire.

### 2.6 UI d'admin (différée à la Phase 4)

**Besoin réel identifié (2026-07-12)** : pouvoir activer/désactiver l'assistant par groupe (`GroupConfig.enabled`) sans redéployer — notamment pour tester sur un groupe WhatsApp de test (ex. "Vincent All") avant de basculer sur un groupe réel (squashacadémie) — et à terme éditer les champs de `GroupConfig` (horaires, créneaux) sans toucher au code.

**Décision (2026-07-12)** : pas d'UI pendant le POC (Phases 0–3). La config (`GroupConfig[]`) est éditée à la main (fichier JSON versionné ou clé Redis) — largement suffisant pour 2–3 groupes de test. Une UI (probablement Next.js, sur le modèle d'`apps/ui` dans huddle-bot — table `groups`/`skills` en DB, toggle actif/inactif) n'est envisagée **qu'en Phase 4**, si le POC est jugé concluant et que le projet passe en usage réel. Raison : éviter d'investir dans une UI qui serait jetée si le POC est abandonné (voir Phase 4, §7).

Si le besoin de bascule rapide entre groupes se fait sentir dès le POC, la solution la plus simple reste d'éditer directement le champ `enabled` dans le fichier de config JSON ou dans Redis (`redis-cli SET group-config:squashacademie-mardi '{"enabled": false, ...}'`) — pas besoin d'UI pour ça à ce stade.

---

## 3. Architecture cible

Pas d'API REST ni d'UI : un **scheduler interne** déclenche le graphe LangGraph à des heures configurées par groupe. Le graphe est un pipeline **linéaire à 4 nœuds**, avec un point de pause (human-in-the-loop) avant réservation.

```
Scheduler interne (par groupe, horaires configurés — §8)
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│                   Graphe LangGraph (par run)                  │
│                                                                 │
│  [1. SendPoll] → [2. CollectVotes] → [3. BookSlots] → [4. Announce] │
│        │               │            (interrupt "go")      │        │
│        ▼               ▼                  ▼                ▼        │
│     Telegram        Telegram          Telegram          Telegram    │
│      (log)           (log)         (log + attend go)      (log)     │
└─────────────────────────────────────────────────────────────┘
     │                    │                    │                  │
     ▼                    ▼                    ▼                  ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ MCP huddle-bot│   │ MCP huddle-bot│  │ MCP resa-squash│  │ MCP huddle-bot│
│  ask_poll     │   │ get_responses │  │ plan_group_bookings│ send_message │
└──────────────┘   └──────────────┘   │ (dry-run→reserve)│ └──────────────┘
                                       └──────────────┘
```

- **1. SendPoll** : envoie le sondage WhatsApp (`ask_poll`, MCP huddle-bot) au groupe cible. Log Telegram.
- **2. CollectVotes** : appelle `get_responses` (MCP huddle-bot, classification oui/non/ambigu déjà faite côté serveur) pour obtenir la liste des joueurs partants. Log Telegram.
- **3. BookSlots** : appelle `plan_group_bookings` en dry-run (MCP resa-squash) pour J+7, envoie le plan sur Telegram, **`interrupt()`** en attendant un "go" (long-polling Telegram, §2.3), puis `reserve_slot` pour chaque créneau retenu. Log Telegram à chaque sous-étape (plan envoyé, go reçu, réservation confirmée).
- **4. Announce** : formate un message regroupant les créneaux adjacents (règle de présentation, §8) et l'envoie au groupe WhatsApp (`send_message`, MCP huddle-bot). Log Telegram.
- **Checkpointer Redis** : persiste l'état du graphe entre les nœuds — notamment pendant la pause `interrupt()` du nœud 3, qui peut durer de quelques minutes à plusieurs heures en attendant la confirmation humaine.

---

## 4. Décisions techniques

| Sujet | Décision | Raison |
|-------|----------|--------|
| Framework agent | **LangGraph.js** (`@langchain/langgraph`), pas Python/FastAPI | Garder une stack TS cohérente avec l'écosystème existant (huddle-bot, resa-squash sont déjà en TS) ; LangGraph a un port JS officiel qui couvre les besoins (StateGraph, human-in-the-loop, checkpointing) |
| Déploiement | K3s — le cluster homelab fonctionne en PAAS, chaque app (dont huddle-bot) y est déployée. Même modèle pour l'orchestrateur : `Deployment` + secrets K8s dans un namespace dédié | Cohérence avec le mode d'opération déjà en place, aucun nouveau mode de déploiement à créer |
| Persistance d'état LangGraph | **Redis self-hosted sur K3s** (`Deployment` + PVC), dédié, pas de HA nécessaire pour un POC | Séparation des responsabilités — l'état du graphe n'a pas à être couplé au Redis Upstash (managé) de resa-squash ; cohérent avec le pattern déjà utilisé pour Postgres huddle-bot (`StatefulSet`/`Deployment` + PVC) |
| Auth vers les MCP | Réutilisation du schéma clé API existant de chaque service (`Authorization: Bearer sk_live_...`, scope `READ_WRITE`/`READ_ONLY`) | Pas de nouveau système d'auth à inventer ; **clé API dédiée au POC** pour chaque service, distincte de celle d'OpenClaw en prod, pour isolation et traçabilité |
| Scope des clés POC | `READ_ONLY` sur les deux MCP tant que possible | Aucune action d'écriture réelle nécessaire pour un POC en dry-run ; limite le blast radius si l'agent se comporte mal |
| Idempotence réservation | Non applicable au POC (dry-run only, jamais `reserve_slot`) | — |
| Idempotence orchestrateur | À vérifier dès le POC via le checkpointer LangGraph | Éviter qu'une reprise après pause humaine/crash ne renvoie deux fois un message Telegram (side-effect déjà exécuté doit être marqué "done" dans le state, pas seulement l'état conversationnel) |
| Telegram | Bot dédié au POC, sortant (log) **et** entrant en long-polling (`getUpdates`, pas de webhook) pour détecter le "go" | Pas de webhook = pas besoin d'Ingress public, cohérent avec `publicHost: none` (§5) ; pas de liaison compte comme resa-squash, hors-sujet ici |
| Déclenchement du pipeline | **Scheduler interne** au process Node (ex. `node-cron`), pas de `CronJob` K8s externe | Le nœud 3 (`BookSlots`) doit rester **en attente** (via `interrupt()` + checkpointer) potentiellement plusieurs heures après son déclenchement — incompatible avec un `CronJob` qui termine son pod après exécution. Un `Deployment` long-running avec scheduler interne convient mieux |
| Config des groupes et horaires | **Définie (§2.5)** : 2 groupes (squashacadémie mardi soir, squash du samedi matin), cycle de déclenchement partagé (mardi 10h sondage / mardi 21h30 décision), date/heure de créneau différente par groupe | Un seul scheduler suffit, itère sur la liste des groupes actifs à chaque déclenchement (voir §2.5) |
| Regroupement des créneaux adjacents | **Présentation uniquement** (message WhatsApp final) — la réservation reste unitaire (1 `reserve_slot` par créneau 45 min). Algorithme porté depuis resa-squash (`slot-merge.ts`), voir §2.5 | Réutilise une logique déjà écrite et déjà utilisée pour un besoin identique (partage UI + Telegram resa-squash) plutôt que d'en réinventer une |

---

## 5. Infra K3s

Le cluster K3s homelab est opéré en mode PAAS : chaque application (huddle-bot, resa-squash le cas échéant, etc.) y a son propre namespace/Deployment/secrets. L'orchestrateur suit le même modèle.

**Ressources à créer** (détail en Phase 0 ci-dessous) :
- Namespace dédié (ex. `squash-assistant`)
- `Deployment: redis` + `PersistentVolumeClaim` (Redis self-hosted, sans HA)
- `Service: redis` (ClusterIP interne au namespace)
- `Deployment: orchestrator` (l'app LangGraph.js)
- `Secret` : clés API MCP (huddle-bot, resa-squash), token bot Telegram + chat_id
- Pas d'Ingress prévu pour le POC (pas d'UI exposée publiquement dans le scope minimal — à ajouter seulement si un pilotage/monitoring externe devient nécessaire)

Pas de contrainte `Recreate` (contrairement au listener WhatsApp huddle-bot) : l'orchestrateur ne maintient pas de session WebSocket unique, un `RollingUpdate` standard convient.

**Pièges opérationnels connus sur ce cluster** (déjà rencontrés deux fois lors du déploiement du bus NATS/ntfy, cf. `plan-nats-event-bus-squash.md`) :
- Si l'app Argo CD est de type **Helm** : un `SealedSecret` doit être placé dans le dossier `templates/` du chart, pas à côté — un fichier posé ailleurs est **silencieusement ignoré** (pod part en `CreateContainerConfigError` sans message clair au premier abord).
- Si l'app Argo CD est de type **Kustomize** : le `SealedSecret` doit être explicitement listé dans `resources:` de `kustomization.yaml`, sinon même symptôme (ignoré silencieusement).
- Toujours activer `syncPolicy.automated.selfHeal: true` **dès la création** du manifeste `Application` Argo CD (leçon apprise sur plusieurs apps du cluster — évite un drift non corrigé automatiquement).

---

## 6. Mini-POC — protocole

### Objectifs

- Valider le pipeline complet en 4 étapes (§1, §3) déclenché sur un **groupe WhatsApp de test** (séparé des groupes de prod foot/squash réels).
- Valider le mécanisme de scheduler interne (déclenchement à heure fixe, sans intervention manuelle).
- Valider la pause `interrupt()` + confirmation "go" via Telegram (long-polling).
- Ne jamais réserver réellement (`reserve_slot` non appelé pendant le POC).

### Déroulement

1. **SendPoll** (déclenché par le scheduler, pas par un utilisateur) : envoie un sondage WhatsApp au groupe de test (`ask_poll`, nécessite une clé `READ_WRITE` dédiée sur ce groupe précis — voir §2.1). Log Telegram.
2. **CollectVotes** (déclenché quelques heures plus tard par le scheduler) : `get_responses` sur le sondage envoyé à l'étape 1. Log Telegram avec la liste des partants.
3. **BookSlots** : `plan_group_bookings` en dry-run (MCP resa-squash, clé `READ_ONLY` suffisante) pour une date de test, plan envoyé sur Telegram, attente d'un "go" manuel (test du long-polling), puis **arrêt volontaire avant `reserve_slot`** — le POC ne va jamais jusqu'à la réservation réelle. Log Telegram à chaque sous-étape.
4. **Announce** : message de test formaté (regroupement de créneaux fictifs) envoyé sur le groupe WhatsApp de test (`send_message`). Log Telegram.

### Hors périmètre du POC

- Aucune réservation réelle (`reserve_slot`/`cancel_reservation` jamais appelés) — le nœud 3 s'arrête juste après la confirmation "go", sans exécuter la réservation.
- Écriture WhatsApp (`ask_poll`/`send_message`) limitée au **groupe de test uniquement**, avec une clé `READ_WRITE` scope dédiée et clairement labellisée pour ce groupe.
- Pas d'impact sur le plan OpenClaw en prod — coexistence actée (§1), pas de "bascule" à décider.
- Groupe WhatsApp de test uniquement, jamais un groupe de prod.

---

## 7. Étapes

### ⏳ Phase 0 — Setup repo (À FAIRE)

- [ ] Créer le nouveau repo (`~/workspace/squash-assistant`)
- [ ] Init projet TS (Node LTS, pnpm), lint/typecheck de base
- [ ] Dépendances : `@langchain/langgraph`, `@modelcontextprotocol/sdk` (client MCP)
- [ ] `docker-compose.yml` local : Redis dédié pour le checkpointer LangGraph (dev)
- [ ] `.env.example` : `HUDDLE_BOT_MCP_URL`, `HUDDLE_BOT_MCP_API_KEY`, `RESA_SQUASH_MCP_URL`, `RESA_SQUASH_MCP_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `REDIS_URL`
- [ ] Obtenir une clé API `READ_ONLY` huddle-bot (script `create-mcp-api-key.ts` côté repo huddle-bot, ou demander à l'opérateur)
- [ ] Obtenir une clé API `READ_ONLY` resa-squash (`https://resa-squash.vercel.app/settings/api-key`)
- [ ] Créer le bot Telegram dédié au POC (@BotFather) + récupérer le `chat_id` du groupe de log
- [ ] Fichier de config `groups.json` (ou clés Redis) suivant le schéma `GroupConfig` (§2.5) — édité à la main pendant le POC, pas d'UI (décision §2.6)
- [ ] Ressources K8s (namespace dédié, ex. `squash-assistant`, sur le cluster K3s PAAS) :
  - [ ] `Deployment: redis` + PVC (Redis self-hosted, pas de HA nécessaire pour le POC)
  - [ ] `Service: redis` (ClusterIP, interne au namespace)
  - [ ] `Deployment: orchestrator` (l'app LangGraph.js elle-même)
  - [ ] `Secret` : clés API MCP (huddle-bot, resa-squash), token bot Telegram + chat_id
  - [ ] Pas d'Ingress prévu pour le POC (pas d'UI exposée publiquement dans le scope minimal)

### ⏳ Phase 1 — Clients MCP + Telegram (À FAIRE)

- [ ] Client MCP huddle-bot : connexion `streamable-http` à `https://huddle-bot.code-advisors.site/api/mcp`, header `Authorization: Bearer <clé>`, test manuel de `list_groups`
- [ ] Client MCP resa-squash : connexion à `https://resa-squash.vercel.app/api/mcp`, test manuel de `list_my_groups` / `plan_group_bookings` (`dryRun: true`)
- [ ] Si erreur d'auth malgré clé valide côté huddle-bot : vérifier le contournement `oauth2-proxy` sur `/api/mcp` (voir piège §2.1)
- [ ] Fonction d'envoi Telegram sortant (`sendMessage` HTTP direct)
- [ ] Fonction d'écoute Telegram entrante (long-polling `getUpdates`), avec détection du texte "go" dans le chat dédié

### ⏳ Phase 2 — Graphe LangGraph 4 nœuds + scheduler (À FAIRE)

- [ ] `StateGraph` avec les 4 nœuds du pipeline (§3) : `SendPoll` → `CollectVotes` → `BookSlots` → `Announce`
- [ ] Config des 2 groupes réels en dur ou en fichier de config (§2.5) : squashacadémie (mardi soir, J+7, 18h45/19h30) et squash du samedi matin (même cycle de déclenchement, samedi suivant, 10h30)
- [ ] Scheduler interne (`node-cron` ou équivalent) : un déclenchement mardi ~10h qui itère sur les 2 groupes pour `SendPoll`, un déclenchement mardi ~21h30 qui itère sur les 2 groupes pour `CollectVotes`→`BookSlots` (chacun avec sa propre date cible)
- [ ] Nœud `BookSlots` : `interrupt()` après envoi du plan dry-run sur Telegram, reprise du graphe déclenchée par la détection du "go" (polling Telegram, Phase 1)
- [ ] Nœud `Announce` : porter `mergeContiguousSlotsByCourt`/`formatMergedCourtSlots` depuis resa-squash (`app/utils/slot-merge.ts`, §2.5) pour formater le message WhatsApp final
- [ ] Brancher le checkpointer Redis, valider la persistance d'état entre les nœuds — en particulier pendant la pause `interrupt()` (simuler un redémarrage de pod pendant la pause et vérifier la reprise)
- [ ] Test du pipeline complet avec des dates/groupes de test, sans dépendance à un vrai groupe WhatsApp (mocks MCP)

### ⏳ Phase 3 — Bout en bout avec WhatsApp de test (À FAIRE)

- [ ] Config d'un groupe de test additionnel (3ᵉ `GroupConfig`, en plus des 2 groupes réels, `enabled: true` uniquement sur celui-ci pendant les tests) : groupe WhatsApp de test (ex. "Vincent All") ↔ "groupe" resa-squash de test, horaires de scheduler resserrés (minutes, pas jours, pour itérer vite)
- [ ] Basculer manuellement `enabled: true` sur squashacadémie / `enabled: false` sur le groupe de test une fois le pipeline validé (édition directe du fichier de config, pas d'UI — §2.6)
- [ ] Exécuter le pipeline complet contre le groupe de test (§6) : sondage réel envoyé, votes réels lus, plan dry-run réel, confirmation "go" réelle via Telegram, annonce réelle — sans jamais appeler `reserve_slot`
- [ ] Vérifier l'absence de double envoi Telegram/WhatsApp en cas de reprise post-interruption (redémarrage du pod pendant l'attente du "go")
- [ ] Vérifier le formatage du regroupement des créneaux adjacents dans le message d'annonce (§2.5) avec des créneaux de test contigus et non contigus

### ⏳ Phase 4 — Évaluation post-POC (À FAIRE)

- [ ] Bilan : fiabilité du scheduler interne, fiabilité du checkpointer Redis JS pendant une pause `interrupt()` longue, qualité du regroupement des créneaux adjacents
- [ ] Décision de suite pour squash-assistant lui-même : passer en usage réel (scopes `READ_WRITE`, vrai groupe), rester en expérimentation, ou abandonner — **sans impact sur le plan OpenClaw** (`plan-squash-auto-openclaw-whatsapp.md`), qui continue son propre cycle indépendamment (cf. §1, décision de coexistence actée)
- [ ] Si passage en usage réel retenu : clés API dédiées prod, passage des scopes en `READ_WRITE`, config définitive des horaires par groupe (§8)
- [ ] Si passage en usage réel retenu : construire l'UI d'admin (§2.6) — toggle par groupe, édition de `GroupConfig`, sur le modèle d'`apps/ui` huddle-bot

---

## 8. Points ouverts

- [x] Nom définitif du nouveau repo — **`squash-assistant`**
- [x] Positionnement vis-à-vis du plan `plan-squash-auto-openclaw-whatsapp.md` — **coexistence assumée**, ce plan OpenClaw n'est ni modifié ni remplacé (voir §1)
- [x] Validation humaine avant réservation — **semi-auto avec confirmation Telegram ("go")**, pas de réservation entièrement autonome (décision 2026-07-12)
- [x] **Config des groupes et horaires** — clarifiée le 2026-07-12, voir §2.5 (2 groupes, cycle de déclenchement partagé, dates/heures cibles différentes)
- [x] **Règle de regroupement des créneaux adjacents** — clarifiée le 2026-07-12 : présentation uniquement, algorithme porté depuis resa-squash, voir §2.5
- [x] **Timing de l'UI d'admin** — décidé le 2026-07-12 (pas de réponse à la question posée, décision prise par défaut selon l'esprit POC/YAGNI du projet) : **pas d'UI pendant le POC**, config `GroupConfig` éditée à la main (fichier/Redis), UI différée à la Phase 4 si le POC est validé — voir §2.6. **Réversible** : à reconfirmer explicitement si le besoin de bascule rapide entre groupes se fait sentir plus tôt que prévu pendant le POC.
- [ ] Choix du checkpointer LangGraph.js pour Redis (le support Redis en JS est communautaire, moins mature que la version Python/Postgres officielle — à valider tôt dans le POC)
- [ ] Décision post-POC pour squash-assistant lui-même : usage réel, expérimentation continue, ou abandon (voir Phase 4, §7)
- [ ] Namespace K3s dédié définitif

---

## 9. Références

Ces documents vivent dans deux autres repos (`huddle-bot` et `resa-squash`), potentiellement inaccessibles depuis le nouveau repo — les informations utiles en ont déjà été extraites ci-dessus (§2). À consulter si accès filesystem disponible (même machine, `~/workspace/`) ou pour approfondir :

- huddle-bot : `docs/adr/ADR-010-mcp-server-openclaw-dans-apps-ui.md`, `docs/post-mortem/2026-07-07-mcp-api-oauth2-proxy-bypass.md`, `apps/ui/src/app/api/mcp/route.ts` (implémentation des tools), `packages/db/scripts/create-mcp-api-key.ts`
- resa-squash : `docs/openclaw-mcp-agent-prod.md` (référence complète des tools MCP), `docs/telegram-notifications.md`, `docs/adr/005-notifications-telegram-groupes.md`
- k3s-homelab : `docs/plan/plan-squash-auto-openclaw-whatsapp.md` (plan OpenClaw équivalent, coexistant), `docs/plan/plan-squash-assistant-k3s.md` (plan jumeau infra de ce document), `scripts/openclaw-context/squash/AGENTS.md` et `scripts/openclaw-context/squash/skills/resa-squash-group-booking.md` (règles métier de réservation à répliquer, cf. §1 et §2.2)