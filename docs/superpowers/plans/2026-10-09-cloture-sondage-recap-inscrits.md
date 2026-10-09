# Clôture du sondage à la collecte + récap des inscrits — plan d'implémentation

> **Pour les agents :** SOUS-SKILL REQUIS : superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans. Étapes en cases à cocher (`- [ ]`).

**Objectif :** À la collecte des votes (étape 2), lire les votes puis supprimer le sondage WhatsApp (jamais relu ensuite), publier un récap épinglé des inscrits, signaler les votants non identifiés sur Telegram, et corriger au passage le planificateur, le compteur et les textes de l'annonce.

**Architecture :** Le nœud `CollectVotes` devient « lecture → suppression → `poll_closed_at` → messages non bloquants » ; une relance après clôture reprend les votes du dernier événement `collect_votes`. Le récap et le message Telegram sont des fonctions pures ; le désépinglage du récap passe par le tick global à la minute (ADR-036) avec une requête dédiée sur `job_runs.recap_msg_id`. Le planificateur expose `plan.meta.courtGroups` pour que l'annonce compte des joueurs sans créneau plutôt que des rounds manquants.

**Stack :** TypeScript, npm workspaces, LangGraph.js, Drizzle ORM (Postgres), node-cron, Vitest, Next.js (UI).

**Spec :** [`docs/superpowers/specs/2026-10-09-cloture-sondage-recap-inscrits-design.md`](../specs/2026-10-09-cloture-sondage-recap-inscrits-design.md). Lisez-la en entier avant de commencer.

## Contraintes globales

- WhatsApp = joueurs : messages concis, sans détail technique, sans ⚠️ qui ne les concerne pas, avec des emojis (😉, 🙏, 🎾, :)). Telegram = organisateur/debug : téléphones, causes et ids y sont bienvenus.
- Heure dans les messages WhatsApp : format du sondage (`formatSessionTime` : « 10h30 », « 9h »), jamais « 10H30 » TeamR. `decisionTime` est déjà « HH:MM » heure de Paris : il n'y a aucun passage par l'UTC.
- Comparaisons d'heures en minutes, heure murale de Paris via `Intl` (`parisMinutesNow`, `computeTargetDate`). Interdit : `slotStartDateIsoHeuristicParis` et `parisCalendarDayBoundsUtc` pour ces décisions.
- Migration **0033** : `job_runs.poll_closed_at` (timestamp sans fuseau), `job_runs.recap_msg_id`, `job_runs.recap_jid` (text). Tout est nullable et sans défaut. On écrit `new Date()` côté Drizzle, jamais `now()` SQL (convention ADR-036).
- La migration est appliquée automatiquement par l'initContainer du worker (ADR-012). Ne demandez jamais de lancer `db:migrate` en prod : cette commande ne sert qu'en dev local.
- ADR-037 : clôture du sondage par suppression du message WhatsApp à la collecte.
- `POLL_CLOSURE_SINCE` : la suppression ne concerne que les jobs `createdAt >= POLL_CLOSURE_SINCE`. Il suit le même principe que `START_REMINDER_SINCE`, et sa valeur ne doit **jamais** précéder l'instant du déploiement.
- Le destinataire du récap est le groupe de l'annonce, lu sur la règle live via `resolveAnnounceNotifyJid`. Il n'y a aucun nouveau réglage. Le récap est envoyé aussi en dry-run.
- Mode test = groupe de l'annonce ≠ groupe du sondage. Dans ce mode, pas de suppression : on désépingle seulement, et `poll_closed_at` reste null.
- AGENTS.md : toute règle métier ou UI est mise à jour dans `docs/spec/regles-fonctionnelles.md` dans la même PR (tâche 12).
- Après chaque modification de code : `graphify update .` (`graphify-out/` est ignoré par git, ne l'ajoutez pas).
- Commits au format conventionnel en français, terminés par la ligne `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Points de vigilance (Review Focus)

1. **Relance de l'étape 2 après suppression** (pod redémarré en cours de nœud) : `get_responses` renverrait « aucune_reponse » pour tous, **sans erreur**, d'où un plan vide silencieux. Test « relance avec poll_closed_at : votes repris de l'événement, get_responses jamais appelé » (tâche 9).
2. **Sondage supprimé mais `poll_closed_at` non écrit** (Postgres indisponible juste après `delete_message`) : si le nœud levait une exception, une relance relirait un sondage vide. L'écriture est donc rattrapée (Telegram « clôture non enregistrée »), et le nœud réussit avec les votes en main. Test « écriture de poll_closed_at en échec : étape réussie » (tâche 9).
3. **Désépinglage du récap qui échoue à chaque minute** : sans garde, le tick enverrait un message Telegram par minute jusqu'au succès. On n'envoie qu'un message Telegram par job, et `recap_msg_id` est conservé. Test « deux ticks en échec : un seul Telegram » (tâche 10).
4. **Job annulé dont le désépinglage immédiat a échoué** (date du match encore loin) : le tick doit réessayer tout de suite plutôt qu'attendre le jour du match. La requête inclut `cancelled_at IS NOT NULL`, et `isRecapUnpinDue` renvoie `true` pour un job annulé. Test « job annulé, match dans 5 jours : dû » (tâche 10).
5. **Joueurs de marge ou prête-noms dans les `courtGroups`** : ils ne sont pas des votants. On ne les compte jamais, même si leur groupe n'a aucun créneau, car le compteur part des seuls confirmés (`confirmedPlayerIdsByTime`). Test « membre non confirmé d'un groupe sans réservation : non compté » (tâche 2).

---

## Structure des fichiers

| Fichier | Rôle |
|---------|------|
| `apps/worker/src/planning/jokerSubstitution.ts` | `resolveBookablePair` ne consomme un prête-nom qu'en cas de succès |
| `apps/worker/src/planning/scheduleGroupTimeline.ts` | `break` sur paire bloquée, avec un seul warning |
| `apps/worker/src/mcp/resaSquash.ts` | Type `CourtGroup`, `meta.courtGroups?` |
| `apps/worker/src/planning/groupBookingPlan.ts`, `planJob.ts` | Remplissage de `meta.courtGroups` (cas courant, cas « queueing », fusion des retardataires) |
| `apps/worker/src/graph/nodes/announce.ts` | `countUnbookedConfirmedPlayers`, titre/échec allégés, synthèse avec non-identifiés |
| `apps/worker/src/graph/state.ts` | Type `UnresolvedVoter`, annotation `unresolvedVoters` |
| `apps/worker/src/graph/resolveVotes.ts` | `unresolvedNames` → `unresolvedVoters` |
| `apps/worker/src/graph/unresolvedVoters.ts` (nouveau) | Message Telegram des non-identifiés, recherche à nouveau par téléphone au recalcul |
| `apps/worker/src/graph/nodes/pollQuestion.ts` | Clôture dans la question, formatteurs exportés |
| `apps/worker/src/graph/nodes/sendPoll.ts` | Clôture calculée à l'envoi, désépinglage du récap précédent |
| `apps/ui/src/lib/pipelinePreview.ts`, `apps/ui/src/app/rules/[id]/jobs/[jobId]/page.tsx` | Aperçu de la question avec la clôture |
| `packages/db/src/schema.ts`, `packages/db/src/migrations/0033_*.sql` (+ meta) | 3 colonnes `job_runs` |
| `apps/worker/src/jobRuns.ts` | Helpers clôture / récap |
| `apps/worker/src/graph/emitEvent.ts` | `findLastSuccessfulEventDetail` |
| `apps/worker/src/graph/nodes/registrationRecap.ts` (nouveau) | Texte du récap WhatsApp (fonction pure) |
| `apps/worker/src/graph/nodes/collectVotes.ts` | Nouveau déroulé de l'étape 2 |
| `apps/worker/src/scheduler/recapUnpin.ts` (nouveau) | `isRecapUnpinDue` (fonction pure) |
| `apps/worker/src/scheduler/scheduler.ts` | `triggerRecapUnpins`, tick, retrait de `triggerRecollectVotes`, recalcul avec recherche à nouveau par téléphone |
| `apps/worker/src/graph/pinning.ts` | `unpinRecapNow` |
| `apps/worker/src/closures/cancelJobForClosure.ts`, `apps/worker/src/http/server.ts` | Annulations après clôture, retrait de la route `recollect-votes` |
| `apps/ui/src/app/actions.ts`, `apps/ui/src/lib/worker.ts`, `apps/ui/src/app/rules/[id]/jobs/[jobId]/Pipeline.tsx` | Retrait de « Relire les réponses », `pollTally` masqué |
| `docs/spec/regles-fonctionnelles.md`, `docs/adr/ADR-037-…md`, `docs/adr/README.md` | Documentation |

---

### Tâche 1 : Planificateur — arrêt au plafond et prête-noms restitués

**Fichiers :**
- Modify : `apps/worker/src/planning/jokerSubstitution.ts:109-157` (`resolveBookablePair`)
- Modify : `apps/worker/src/planning/scheduleGroupTimeline.ts:75-150`
- Modify (assertion devenue fausse) : `apps/worker/src/planning/groupBookingPlan.test.ts:212-229`
- Test : `apps/worker/src/planning/jokerSubstitution.test.ts`, `apps/worker/src/planning/scheduleGroupTimeline.test.ts`

**Interfaces :**
- Consomme : `resolveBookablePair(input: { userId: string; partnerId: string; blockedIds: ReadonlySet<string>; substituteQueue: string[]; jokerBookerId: string | null }): ResolvedPair | null` et `scheduleGroupTimeline(opts: ScheduleGroupTimelineOptions): GroupBookingPlan["proposedBookings"]`.
- Produit : les mêmes signatures. Seule la sémantique change : `substituteQueue` n'est mutée que si le résultat est non null ; `scheduleGroupTimeline` s'arrête au premier round bloqué.

- [ ] **Étape 1 : Écrire les tests qui échouent**

Ajouter en fin de `jokerSubstitution.test.ts` (l'import de `resolveBookablePair` existe déjà en tête du fichier, sinon l'ajouter à l'import de `./jokerSubstitution.js`) :

```ts
describe("resolveBookablePair — file de prête-noms restituée sur échec (spec 2026-10-09 §4.1)", () => {
  it("paire irrécupérable : le prête-nom pris pour une place n'est pas perdu", () => {
    const queue = ["s1"];
    const result = resolveBookablePair({
      userId: "a",
      partnerId: "b",
      blockedIds: new Set(["a", "b"]),
      substituteQueue: queue,
      jokerBookerId: null,
    });
    expect(result).toBeNull();
    expect(queue).toEqual(["s1"]);
  });

  it("succès : le prête-nom utilisé est bien consommé", () => {
    const queue = ["s1", "s2"];
    const result = resolveBookablePair({
      userId: "a",
      partnerId: "b",
      blockedIds: new Set(["a"]),
      substituteQueue: queue,
      jokerBookerId: null,
    });
    expect(result).toEqual({ userId: "s1", partnerId: "b", replacements: [{ replaced: "a", by: "s1", kind: "substitute" }] });
    expect(queue).toEqual(["s2"]);
  });
});
```

Ajouter dans le `describe("scheduleGroupTimeline")` de `scheduleGroupTimeline.test.ts` (les helpers `makeSlots` / `byTimeFrom` existent déjà) :

```ts
  const DAY_TIMES = ["10H30", "11H15", "12H00", "12H45", "13H30", "14H15"];
  function daySlots(): AvailableSlot[] {
    const ends = ["11H15", "12H00", "12H45", "13H30", "14H15", "15H00"];
    return DAY_TIMES.flatMap((t, i) => makeSlots([1], t, ends[i]!));
  }

  it("plafond atteint au 3e round sans prête-nom ni joker : arrêt, un seul warning, pas de « créneaux insuffisants »", () => {
    const warnings: string[] = [];
    const bookings = scheduleGroupTimeline({
      group: { members: ["vincent", "hugo"], roundsNeeded: 3 },
      startTime: "10H30",
      onDate: "2026-10-10",
      groupId: "g1",
      byTime: byTimeFrom(daySlots()),
      sortedTimes: DAY_TIMES,
      claimedThisCall: new Set(),
      courtPriority: [1],
      substituteQueue: [],
      existingDailyCounts: {},
      maxDailyReservationsPerPlayer: 2,
      warnings,
    });

    expect(bookings).toHaveLength(2);
    expect(warnings).toEqual([
      "vincent, hugo : 3e round demandé mais plafond 2 résas/jour atteint — aucun prête-nom disponible et aucun joker configuré sur la règle.",
    ]);
  });

  it("plafond atteint, joker configuré mais déjà insuffisant : variante « joker déjà mobilisé »", () => {
    const warnings: string[] = [];
    scheduleGroupTimeline({
      group: { members: ["vincent", "hugo"], roundsNeeded: 3 },
      startTime: "10H30",
      onDate: "2026-10-10",
      groupId: "g1",
      byTime: byTimeFrom(daySlots()),
      sortedTimes: DAY_TIMES,
      claimedThisCall: new Set(),
      courtPriority: [1],
      substituteQueue: [],
      existingDailyCounts: {},
      maxDailyReservationsPerPlayer: 2,
      jokerBookerId: "joker",
      warnings,
    });

    expect(warnings).toEqual([
      "vincent, hugo : 3e round demandé mais plafond 2 résas/jour atteint — aucun prête-nom disponible et joker déjà mobilisé.",
    ]);
  });

  it("joueurs non réinscrits : arrêt dès le 1er round, un seul warning", () => {
    const warnings: string[] = [];
    const bookings = scheduleGroupTimeline({
      group: { members: ["a", "b"], roundsNeeded: 2 },
      startTime: "10H30",
      onDate: "2026-10-10",
      groupId: "g1",
      byTime: byTimeFrom(daySlots()),
      sortedTimes: DAY_TIMES,
      claimedThisCall: new Set(),
      courtPriority: [1],
      substituteQueue: [],
      existingDailyCounts: {},
      maxDailyReservationsPerPlayer: 2,
      unregisteredPlayerIds: new Set(["a", "b"]),
      warnings,
    });

    expect(bookings).toEqual([]);
    expect(warnings).toEqual([
      "a, b : 1er round demandé mais pas réinscrit pour la saison — aucun prête-nom disponible et aucun joker configuré sur la règle.",
    ]);
  });

  it("paire bloquée : le prête-nom tenté est restitué à la file pour les groupes suivants", () => {
    const queue = ["sub-1"];
    const bookings = scheduleGroupTimeline({
      group: { members: ["a", "b"], roundsNeeded: 1 },
      startTime: "10H30",
      onDate: "2026-10-10",
      groupId: "g1",
      byTime: byTimeFrom(daySlots()),
      sortedTimes: DAY_TIMES,
      claimedThisCall: new Set(),
      courtPriority: [1],
      substituteQueue: queue,
      existingDailyCounts: { a: 2, b: 2 },
      maxDailyReservationsPerPlayer: 2,
      warnings: [],
    });

    expect(bookings).toEqual([]);
    expect(queue).toEqual(["sub-1"]);
  });
```

- [ ] **Étape 2 : Lancer les tests (échec attendu)**

Run : `npm run worker:test -- jokerSubstitution.test.ts scheduleGroupTimeline.test.ts`
Résultat attendu : FAIL. On voit `queue` vidé (`[]`), un warning par créneau au format « … réservation ignorée pour cette paire (12H00) … », et le warning final « 2/3 round(s) réservé(s) — créneaux insuffisants ».

- [ ] **Étape 3 : Implémenter**

Dans `jokerSubstitution.ts`, `resolveBookablePair` : on travaille sur une copie et on ne valide la consommation qu'en cas de succès. Remplacer le corps de la fonction (l.117-156) par :

```ts
  const { blockedIds, jokerBookerId } = input;
  const isBlocked = (id: string) => id !== jokerBookerId && blockedIds.has(id);
  // Copie de travail : un prête-nom pris pour une paire finalement irrécupérable doit rester
  // disponible pour les groupes suivants (spec 2026-10-09 §4.1).
  const queue = [...input.substituteQueue];

  let userId = input.userId;
  let partnerId = input.partnerId;
  const replacements: PairReplacement[] = [];

  // 1. Prête-noms en priorité, sur n'importe quelle place (ce sont des joueurs ordinaires).
  for (const role of ["userId", "partnerId"] as const) {
    const current = role === "userId" ? userId : partnerId;
    if (!isBlocked(current)) continue;

    const index = queue.findIndex((sub) => !isBlocked(sub) && sub !== userId && sub !== partnerId);
    if (index === -1) continue;
    const sub = queue.splice(index, 1)[0]!;
    if (role === "userId") userId = sub;
    else partnerId = sub;
    replacements.push({ replaced: current, by: sub, kind: "substitute" });
  }

  const commit = (pair: ResolvedPair): ResolvedPair => {
    input.substituteQueue.splice(0, input.substituteQueue.length, ...queue);
    return pair;
  };

  // 2. Joker en dernier recours, partenaire uniquement, une seule fois par ligne.
  const stillBlocked = (["userId", "partnerId"] as Array<"userId" | "partnerId">).filter((role) =>
    isBlocked(role === "userId" ? userId : partnerId),
  );
  if (stillBlocked.length === 0) return commit({ userId, partnerId, replacements });
  if (!jokerBookerId || userId === jokerBookerId || partnerId === jokerBookerId) return null;
  // Le joker ne couvre qu'une place : deux joueurs encore bloqués = paire irrécupérable.
  if (stillBlocked.length > 1) return null;

  if (stillBlocked[0] === "partnerId") {
    replacements.push({ replaced: partnerId, by: jokerBookerId, kind: "joker" });
    partnerId = jokerBookerId;
  } else {
    // Titulaire bloqué : le partenaire (valide) devient titulaire, le joker passe partenaire.
    replacements.push({ replaced: userId, by: jokerBookerId, kind: "joker" });
    userId = partnerId;
    partnerId = jokerBookerId;
  }

  return userId === partnerId ? null : commit({ userId, partnerId, replacements });
```

Mettre à jour le JSDoc du champ (l.113) : `/** File de prête-noms par ordre de priorité — mutée seulement si la paire est résolue (consommation validée au succès). */`.

Dans `scheduleGroupTimeline.ts` :

1. Juste après les imports, ajouter :

```ts
function roundOrdinal(n: number): string {
  return n === 1 ? "1er" : `${n}e`;
}
```

2. Avant la boucle `for (const t of timesFrom)` (l.75), déclarer `let stoppedOnBlockedPair = false;`.
3. Remplacer le bloc `if (!resolved) { … continue; }` (l.115-121) par :

```ts
      if (!resolved) {
        // La paire du round ne change pas tant que rien n'est réservé (roundIndex = bookings.length)
        // et le blocage ne dépend pas du créneau : réessayer plus tard échouerait à l'identique.
        const blame = [userId, partnerId].filter((id) => blockedIds.has(id));
        const cause = unregisteredPlayerIds?.has(blame[0]!)
          ? "pas réinscrit pour la saison"
          : `plafond ${maxDailyReservationsPerPlayer} résas/jour atteint`;
        warnings.push(
          `${blame.join(", ")} : ${roundOrdinal(roundIndex + 1)} round demandé mais ${cause} — aucun prête-nom disponible${jokerBookerId ? " et joker déjà mobilisé" : " et aucun joker configuré sur la règle"}.`,
        );
        stoppedOnBlockedPair = true;
        break;
      }
```

4. Remplacer la condition du warning final (l.146) par `if (!stoppedOnBlockedPair && bookings.length < group.roundsNeeded) {`.

Dans `groupBookingPlan.test.ts`, test « joueur non-titulaire à quota sans prête-nom disponible… » (l.212), remplacer l'assertion des warnings par :

```ts
    expect(
      plan.warnings.some(
        (w) => w.includes("stephane : 1er round demandé mais plafond 2 résas/jour atteint") && w.includes("aucun prête-nom disponible"),
      ),
    ).toBe(true);
```

- [ ] **Étape 4 : Relancer les tests (PASS attendu)**

Run : `npm run worker:test -- jokerSubstitution.test.ts scheduleGroupTimeline.test.ts groupBookingPlan.test.ts planJob.test.ts scenarios.regression.test.ts sessionExtension.test.ts`
Résultat attendu : PASS.

- [ ] **Étape 5 : Commit**

```bash
git add apps/worker/src/planning/jokerSubstitution.ts apps/worker/src/planning/jokerSubstitution.test.ts apps/worker/src/planning/scheduleGroupTimeline.ts apps/worker/src/planning/scheduleGroupTimeline.test.ts apps/worker/src/planning/groupBookingPlan.test.ts
git commit -m "fix(planning): arrêt au plafond et prête-noms restitués quand la paire reste bloquée

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tâche 2 : `meta.courtGroups` et compteur de l'annonce

**Fichiers :**
- Modify : `apps/worker/src/mcp/resaSquash.ts:84-110` (type `GroupBookingPlan`)
- Modify : `apps/worker/src/planning/groupBookingPlan.ts:172-184` (`emptyMeta`), `:213-281` (`computeCommonCasePlan`), `:283-531` (`computeQueueingCasePlan`)
- Modify : `apps/worker/src/planning/planJob.ts:27-54` (`mergedIntoSessionPlan`), `:97-122` (`notEnoughPlayersPlan`), `:365` (fusion)
- Modify : `apps/worker/src/graph/nodes/announce.ts:18`, `:58-71` (après `reservedBookings`), `:515-518`, `:605-606`
- Test : `apps/worker/src/planning/groupBookingPlan.test.ts`, `apps/worker/src/planning/planJob.test.ts`, `apps/worker/src/graph/nodes/announce.test.ts`

**Interfaces :**
- Produit : `export interface CourtGroup { members: string[]; sessionIds: string[] }` (resaSquash.ts) ; `GroupBookingPlan["meta"].courtGroups?: CourtGroup[]` (absent des anciens checkpoints, `[]` pour un plan sans court) ; `export function countUnbookedConfirmedPlayers(bookingPlanGroups: BookingPlanGroup[], confirmedPlayerIdsByTime: Record<string, string[]>, reservationFailures?: ReservationFailure[]): number` (announce.ts).

- [ ] **Étape 1 : Écrire les tests qui échouent**

Dans `groupBookingPlan.test.ts`, ajouter dans le `describe("computeGroupBookingPlan")` :

```ts
  it("meta.courtGroups (cas courant) : un groupe par court, joueur en rotation inclus, sessionIds du groupe", () => {
    const availableSlots = [
      ...makeSlots([4, 3], "18H45", "19H30"),
      ...makeSlots([4, 3], "19H30", "20H15"),
      ...makeSlots([4, 3], "20H15", "21H00"),
    ];
    const plan = computeGroupBookingPlan(baseInput({ expectedPlayerIds: ["a", "b", "c"], maxCourts: 1, availableSlots }));

    expect(plan.meta.courtGroups).toHaveLength(1);
    expect([...plan.meta.courtGroups![0]!.members].sort()).toEqual(["a", "b", "c"]);
    expect(plan.meta.courtGroups![0]!.sessionIds).toEqual(plan.proposedBookings.map((b) => b.sessionId));
  });

  it("meta.courtGroups (cas « queueing », maxPlayersPerCourt=2) : une entrée par paire, chaque session rattachée à sa paire", () => {
    const availableSlots = [...makeSlots([1, 2, 3, 4], "10H30", "11H15"), ...makeSlots([1, 2, 3, 4], "11H15", "12H00")];
    const plan = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["a", "b", "c", "d", "e", "f", "g", "h"],
        slotsPerPlayer: 2,
        maxCourts: 3,
        maxPlayersPerCourt: 2,
        preferMinPlayersPerCourt: true,
        startTime: "10H30",
        availableSlots,
      }),
    );

    const groups = plan.meta.courtGroups!;
    expect(groups).toHaveLength(4);
    expect(groups.flatMap((g) => g.members).sort()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(groups.flatMap((g) => g.sessionIds).sort()).toEqual(plan.proposedBookings.map((b) => b.sessionId).sort());
  });

  it("meta.courtGroups vide quand aucun créneau n'est disponible", () => {
    const plan = computeGroupBookingPlan(baseInput({ expectedPlayerIds: ["a", "b"], availableSlots: [] }));
    expect(plan.meta.courtGroups).toEqual([]);
  });
```

Dans `planJob.test.ts`, à la fin du test « 2 @ 18H45 + 1 @ 19H30 + prête-nom : V/T plafonnés à 2, puis Martin+prête-nom », ajouter :

```ts
    // Le retardataire fusionné appartient au groupe de court de la session 18H45 (spec 2026-10-09 §4.2).
    const merged = groups[0]!.plan.meta.courtGroups!.find((g) => g.members.includes(martin));
    expect(merged?.sessionIds).toEqual(expect.arrayContaining(bookings.slice(2).map((b) => b.sessionId)));
    expect(groups[1]!.plan.meta.courtGroups).toEqual([]);
```

Dans `announce.test.ts`, ajouter `countUnbookedConfirmedPlayers` à la déstructuration de `await import("./announce.js")` (l.72-82) puis ajouter en fin de fichier :

```ts
describe("countUnbookedConfirmedPlayers (spec 2026-10-09 §4.2)", () => {
  const booking = (sessionId: string, court: number) => ({
    sessionId,
    court,
    userId: "x",
    partnerId: "y",
    slotTime: "10H30",
    slotEndTime: "11H15",
  });
  const planGroup = (
    proposed: Array<ReturnType<typeof booking>>,
    courtGroups: Array<{ members: string[]; sessionIds: string[] }> | undefined,
    outOfWindowSessionIds: string[] = [],
  ): BookingPlanGroup =>
    group({
      startTime: "10H30",
      outOfWindowSessionIds,
      plan: { ...group().plan, proposedBookings: proposed, meta: { ...group().plan.meta, courtGroups } },
    });
  const votes = { "10H30": ["hugo", "vincent", "gaetan", "martin"] };

  it("job 04578758 : les deux groupes jouent (un round manquant) → 0", () => {
    const groups = [
      planGroup([booking("s1", 4), booking("s2", 4), booking("s3", 3), booking("s4", 3)], [
        { members: ["vincent", "hugo"], sessionIds: ["s1", "s2"] },
        { members: ["gaetan", "martin"], sessionIds: ["s3", "s4"] },
      ]),
    ];
    expect(countUnbookedConfirmedPlayers(groups, votes)).toBe(0);
  });

  it("groupe sans aucune réservation : ses membres sont comptés", () => {
    const groups = [
      planGroup([booking("s1", 4)], [
        { members: ["vincent", "hugo"], sessionIds: ["s1"] },
        { members: ["gaetan", "martin"], sessionIds: [] },
      ]),
    ];
    expect(countUnbookedConfirmedPlayers(groups, votes)).toBe(2);
  });

  it("confirmé absent de tout groupe de court : compté", () => {
    const groups = [planGroup([booking("s1", 4)], [{ members: ["vincent", "hugo"], sessionIds: ["s1"] }])];
    expect(countUnbookedConfirmedPlayers(groups, { "10H30": ["vincent", "hugo", "gaetan"] })).toBe(1);
  });

  it("joueur en rotation (membre du groupe, sans ligne TeamR) : non compté", () => {
    const groups = [planGroup([booking("s1", 4)], [{ members: ["vincent", "hugo", "gaetan"], sessionIds: ["s1"] }])];
    expect(countUnbookedConfirmedPlayers(groups, { "10H30": ["vincent", "hugo", "gaetan"] })).toBe(0);
  });

  it("créneaux hors fenêtre ou refusés : le groupe compte comme non réservé", () => {
    const outOfWindow = [planGroup([booking("s1", 4)], [{ members: ["vincent", "hugo"], sessionIds: ["s1"] }], ["s1"])];
    expect(countUnbookedConfirmedPlayers(outOfWindow, { "10H30": ["vincent", "hugo"] })).toBe(2);

    const refused = [planGroup([booking("s1", 4)], [{ members: ["vincent", "hugo"], sessionIds: ["s1"] }])];
    const failure = { sessionId: "s1", court: 4, slotTime: "10H30", slotEndTime: "11H15", userId: "x", partnerId: "y", reason: null, message: "m", rawError: "r" };
    expect(countUnbookedConfirmedPlayers(refused, { "10H30": ["vincent", "hugo"] }, [failure])).toBe(2);
  });

  it("membre non confirmé (marge, prête-nom) d'un groupe sans réservation : non compté", () => {
    const groups = [planGroup([], [{ members: ["sub-1", "sub-2"], sessionIds: [] }])];
    expect(countUnbookedConfirmedPlayers(groups, { "10H30": [] })).toBe(0);
  });

  it("ancien checkpoint sans courtGroups : 0", () => {
    const groups = [planGroup([], undefined)];
    expect(countUnbookedConfirmedPlayers(groups, votes)).toBe(0);
  });
});
```

- [ ] **Étape 2 : Lancer les tests (échec attendu)**

Run : `npm run worker:test -- groupBookingPlan.test.ts planJob.test.ts announce.test.ts`
Résultat attendu : FAIL. On voit `courtGroups` undefined et `countUnbookedConfirmedPlayers is not a function`.

- [ ] **Étape 3 : Implémenter**

`resaSquash.ts`, juste avant `export interface GroupBookingPlan` :

```ts
/** Joueurs réels d'un même court (rotateurs compris) et les sessions réservées pour eux — compteur de l'annonce (spec 2026-10-09 §4.2). */
export interface CourtGroup {
  members: string[];
  sessionIds: string[];
}
```

Dans `meta`, après `rotatingPlayerIds?: string[];` :

```ts
    /** Absent des checkpoints antérieurs au 2026-10-09 ; `[]` pour un plan sans court. */
    courtGroups?: CourtGroup[];
```

`groupBookingPlan.ts` :
- importer le type : `import type { CourtGroup, GroupBookingPlan } from "../mcp/resaSquash.js";` (remplace l'import l.1) ;
- dans `emptyMeta` (l.172-184), ajouter `courtGroups: [] as CourtGroup[],` après `rotatingPlayerIds: [...rotatingPlayerIds],` ;
- `computeCommonCasePlan` : remplacer la boucle l.236-254 par :

```ts
  const courtGroups: CourtGroup[] = [];
  for (const group of groups) {
    const bookings = scheduleGroupTimeline({
      group,
      startTime: input.startTime,
      onDate: input.onDate,
      groupId: input.groupId,
      byTime,
      sortedTimes,
      claimedThisCall,
      courtPriority: input.courtPriority,
      substituteQueue,
      unregisteredPlayerIds: input.unregisteredPlayerIds,
      jokerBookerId: input.jokerBookerId,
      existingDailyCounts: input.existingDailyCounts ?? {},
      maxDailyReservationsPerPlayer: input.maxDailyReservationsPerPlayer,
      warnings,
    });
    proposedBookings.push(...bookings);
    courtGroups.push({ members: [...group.members], sessionIds: bookings.map((b) => b.sessionId) });
  }
```

puis ajouter `courtGroups,` dans l'objet `meta` retourné (après `groupMaxSlotsPerPlayer,`).

- `computeQueueingCasePlan` :
  - après `const claimedThisCall = new Set<string>();` (l.306), ajouter `const sessionIdsByPair = new Map<GroupBookingPair, string[]>();` ;
  - juste après `claimedThisCall.add(slot.sessionId);` (l.436), ajouter `sessionIdsByPair.set(pr, [...(sessionIdsByPair.get(pr) ?? []), slot.sessionId]);` ;
  - juste avant `if (rotatingPlayerIds.length > 0 && proposedWithMeta.length > 0) {` (l.465), ajouter :

```ts
  const courtGroups: CourtGroup[] = pairs.map((pr) => ({
    members: [pr.userId, pr.partnerId],
    sessionIds: sessionIdsByPair.get(pr) ?? [],
  }));
  const placedRotators = new Set<string>();
```

  - dans la boucle `for (const session of sessions)`, juste avant `remainingRotators = remainingRotators.filter(...)` (l.507), ajouter :

```ts
      for (const id of remainingRotators) {
        if (!session.members.includes(id)) continue;
        placedRotators.add(id);
        courtGroups.push({ members: [id], sessionIds: session.proposedBookings.map((b) => b.sessionId) });
      }
```

  - juste avant le `return` final (l.525), ajouter :

```ts
  // Rotateur non rattaché à une session : il tourne sur un court sans ligne TeamR (warning ci-dessus).
  const unplacedRotators = rotatingPlayerIds.filter((id) => !placedRotators.has(id));
  if (unplacedRotators.length > 0 && courtGroups.length > 0) {
    courtGroups[0] = { ...courtGroups[0]!, members: [...courtGroups[0]!.members, ...unplacedRotators] };
  }
```

  - et remplacer `meta: { ...emptyMeta, roundsPlanned: totalRounds },` par `meta: { ...emptyMeta, roundsPlanned: totalRounds, courtGroups },`.

`planJob.ts` :
- dans `mergedIntoSessionPlan` et `notEnoughPlayersPlan`, ajouter `courtGroups: [],` après `pairCount: 0,` ;
- après `appendBookingsToGroupPlan(anchorGroup.plan, extra, mergeTarget.members.slice(2));` (l.365), ajouter :

```ts
        // Les retardataires jouent sur le court de la session qui les accueille (compteur de l'annonce).
        anchorGroup.plan.meta.courtGroups = [
          ...(anchorGroup.plan.meta.courtGroups ?? []),
          {
            members: confirmedPlayerIds.filter((id) => mergeTarget.members.includes(id)),
            sessionIds: mergeTarget.proposedBookings.map((b) => b.sessionId),
          },
        ];
```

`announce.ts` :
- supprimer l'import l.18 (`countPlayersInSessions`, `computeShortfall` ne servent plus ici) ;
- après la fonction `reservedBookings` (l.71), ajouter :

```ts
/**
 * Joueurs confirmés (votes) sans aucun créneau réservé — compteur « ⚠️ N joueur(s)… » de l'annonce
 * (spec 2026-10-09 §4.2). Un joueur compte comme réservé dès qu'un des groupes de court dont il est
 * membre (rotateurs compris) a au moins une session réellement prise. Un round manquant d'un groupe
 * qui joue ne compte pas. Ancien checkpoint sans `courtGroups` : 0 (ligne omise).
 */
export function countUnbookedConfirmedPlayers(
  bookingPlanGroups: BookingPlanGroup[],
  confirmedPlayerIdsByTime: Record<string, string[]>,
  reservationFailures: ReservationFailure[] = [],
): number {
  if (bookingPlanGroups.some((g) => g.plan.meta.courtGroups === undefined)) return 0;
  const reserved = new Set(reservedBookings(bookingPlanGroups, reservationFailures).map((b) => b.sessionId));
  const booked = new Set<string>();
  for (const g of bookingPlanGroups) {
    for (const courtGroup of g.plan.meta.courtGroups ?? []) {
      if (!courtGroup.sessionIds.some((id) => reserved.has(id))) continue;
      for (const member of courtGroup.members) booked.add(member);
    }
  }
  const confirmed = new Set(Object.values(confirmedPlayerIdsByTime).flat());
  return [...confirmed].filter((id) => !booked.has(id)).length;
}
```

- dans `createAnnounceNode`, supprimer la déclaration `const unplacedPlayerCount = groups.reduce(…);` (l.515-518) et, dans le callback de `withEventLogging`, juste avant `const capacityNote =` (l.605), ajouter :

```ts
        const unplacedPlayerCount = countUnbookedConfirmedPlayers(groups, confirmedPlayerIdsByTime ?? {}, reservationFailures);
```

- [ ] **Étape 4 : Relancer les tests (PASS attendu)**

Run : `npm run worker:test -- groupBookingPlan.test.ts planJob.test.ts announce.test.ts scenarios.regression.test.ts simulateScenario.test.ts bookSlots.test.ts && npm run worker:typecheck`
Résultat attendu : PASS.

- [ ] **Étape 5 : Commit**

```bash
git add apps/worker/src/mcp/resaSquash.ts apps/worker/src/planning/groupBookingPlan.ts apps/worker/src/planning/groupBookingPlan.test.ts apps/worker/src/planning/planJob.ts apps/worker/src/planning/planJob.test.ts apps/worker/src/graph/nodes/announce.ts apps/worker/src/graph/nodes/announce.test.ts
git commit -m "fix(announce): compter les joueurs sans créneau via meta.courtGroups, plus les rounds manquants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tâche 3 : Allègement des messages WhatsApp de l'annonce (§4.3)

**Fichiers :**
- Modify : `apps/worker/src/graph/nodes/announce.ts:565-569` (message d'échec total), `:601-613` (titre, signature)
- Modify : `apps/worker/src/scripts/test-graph.ts:436-439`
- Test : `apps/worker/src/graph/nodes/announce.test.ts` (l.369-375, l.1103, l.1111, plus de nouveaux tests)

**Interfaces :**
- Produit : `export function buildAnnounceTitle(realBooking: boolean, mergedSlotCount: number): string` et `export function buildTotalFailureMessage(targetDate: string): string` (announce.ts).

- [ ] **Étape 1 : Écrire / adapter les tests (échec attendu)**

Ajouter `buildAnnounceTitle, buildTotalFailureMessage` à la déstructuration de `await import("./announce.js")`, puis ajouter en fin de `announce.test.ts` :

```ts
describe("annonce allégée (spec 2026-10-09 §4.3)", () => {
  it("titre accordé au nombre de créneaux fusionnés, sans nom de règle ni « (s) »", () => {
    expect(buildAnnounceTitle(true, 1)).toBe("🏸 Réservation confirmée");
    expect(buildAnnounceTitle(true, 2)).toBe("🏸 Réservations confirmées");
    expect(buildAnnounceTitle(false, 1)).toBe("🏸 Réservation");
    expect(buildAnnounceTitle(false, 3)).toBe("🏸 Réservations");
  });

  it("message d'échec total", () => {
    expect(buildTotalFailureMessage("2026-07-21")).toBe(
      "⚠️ Échec de la réservation du 2026-07-21 : aucun court n'a été réservé. Contactez l'organisateur.",
    );
  });

  const announceState = (dryRun: boolean): PipelineStateType => ({
    bookingRule: rule({ name: "Mardi soir" }),
    jobRunId: "job-1",
    targetDate: "2026-07-21",
    pollRequestId: "poll-1",
    clubClosed: false,
    confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane"] },
    volunteerSubstituteIds: [],
    bookingPlanGroups: [group()],
    goConfirmed: true,
    dryRun,
    announceMessage: undefined,
    reservationFailures: undefined,
  });

  it("dry-run : titre court, pas de nom de règle", async () => {
    const result = await createAnnounceNode(deps())(announceState(true));
    expect(result.announceMessage).toBe("🏸 Réservation\n\n📅 2026-07-21\n\nCourt 4 : 18H45-19H30");
  });

  it("réel : « confirmée » et plus de signature 🤖", async () => {
    vi.mocked(reserveSlot).mockReset().mockResolvedValue({} as never);
    const result = await createAnnounceNode(deps())(announceState(false));
    expect(result.announceMessage).toBe("🏸 Réservation confirmée\n\n📅 2026-07-21\n\nCourt 4 : 18H45-19H30");
    expect(result.announceMessage).not.toContain("squash-assistant");
  });
});
```

Adapter les tests existants :
- l.369-375 (test « bugfix 2026-08-26… ») : remplacer `expect.stringContaining("échec de la réservation automatique")` par `"⚠️ Échec de la réservation du 2026-07-21 : aucun court n'a été réservé. Contactez l'organisateur."`.
- l.1103 : remplacer `String(c[2]).includes("Réservation(s) confirmée(s)")` par `String(c[2]).startsWith("🏸 Réservation confirmée")`.
- l.1111 : remplacer `expect(text).not.toContain("échec de la réservation automatique");` par `expect(text).not.toContain("Échec de la réservation");`.

Note : à ce stade (après la tâche 2), `group()` n'a pas de `courtGroups` : le compteur vaut 0 et la ligne ⚠️ est omise. C'est ce que vérifient les égalités exactes ci-dessus.

- [ ] **Étape 2 : Lancer les tests (échec attendu)**

Run : `npm run worker:test -- announce.test.ts`
Résultat attendu : FAIL. `buildAnnounceTitle is not a function`, le message commence par « 🏸 Réservation(s) « Mardi soir » », et le texte d'échec est l'ancien.

- [ ] **Étape 3 : Implémenter**

Dans `announce.ts`, juste avant `export type BookingMessageVariant` (l.451), ajouter :

```ts
/** Titre WhatsApp de l'annonce, accordé au nombre de créneaux fusionnés (spec 2026-10-09 §4.3). */
export function buildAnnounceTitle(realBooking: boolean, mergedSlotCount: number): string {
  const plural = mergedSlotCount >= 2;
  if (realBooking) return plural ? "🏸 Réservations confirmées" : "🏸 Réservation confirmée";
  return plural ? "🏸 Réservations" : "🏸 Réservation";
}

/** Message WhatsApp quand aucune ligne n'a pu être réservée — générique, jamais le texte brut. */
export function buildTotalFailureMessage(targetDate: string): string {
  return `⚠️ Échec de la réservation du ${targetDate} : aucun court n'a été réservé. Contactez l'organisateur.`;
}
```

Dans `createAnnounceNode` :
- remplacer le 3ᵉ argument de `sendMessage` dans le `catch` de la réservation réelle (l.568) par `buildTotalFailureMessage(targetDate),` ;
- supprimer `const prefix = …` (l.601) et le bloc `originNote` avec ses 3 lignes de commentaire (l.607-610) ;
- remplacer la construction du message (l.613) par :

```ts
        const message = `${buildAnnounceTitle(realBooking, merged.length)}\n\n📅 ${targetDate}\n\n${formatMergedCourtSlots(merged)}${failuresNote}${capacityNote}`;
```

Dans `apps/worker/src/scripts/test-graph.ts` (l.436-439), remplacer `"confirmée(s)"` par `"confirmée"` dans la condition, dans le message d'erreur et dans le `console.log` (`("Réservation confirmée")`).

- [ ] **Étape 4 : Relancer les tests (PASS attendu)**

Run : `npm run worker:test -- announce.test.ts && npm run worker:typecheck`
Résultat attendu : PASS.

- [ ] **Étape 5 : Commit**

```bash
git add apps/worker/src/graph/nodes/announce.ts apps/worker/src/graph/nodes/announce.test.ts apps/worker/src/scripts/test-graph.ts
git commit -m "feat(announce): titre et message d'échec allégés, signature automatique retirée

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tâche 4 : Retrait de « Relire les réponses » et masquage de `pollTally`

**Fichiers :**
- Modify : `apps/worker/src/scheduler/scheduler.ts:6-8` (imports), `:119-133` (commentaire de `pausedOnFromSnapshot`), `:500-554` (`triggerRecollectVotes`, supprimé), `:605-614` (JSDoc de `triggerRecomputePlan`)
- Modify : `apps/worker/src/http/server.ts:16-26`, `:41-42`, `:168`, `:387`, `:409-410`
- Modify : `apps/worker/src/graph/resolveVotes.ts:14-22` (JSDoc)
- Modify : `apps/worker/src/scripts/test-graph.ts:67`, `:269-272` (commentaires et libellé)
- Modify : `apps/ui/src/lib/worker.ts:156`, `apps/ui/src/app/actions.ts:263-269`, `apps/ui/src/app/rules/[id]/jobs/[jobId]/Pipeline.tsx:9`, `:334`, `:403-410`
- Test : vérification par `grep` + typecheck (suppression pure, aucun comportement nouveau à tester)

**Interfaces :**
- Retire : `triggerRecollectVotes` (scheduler), l'action `"recollect-votes"` (worker HTTP + `triggerJobAction` UI) et `triggerRecollectVotesAction` (UI).

- [ ] **Étape 1 : Constater les références (le « test » qui échoue)**

Run : `grep -rn -i "recollect" apps/worker/src apps/ui/src`
Résultat attendu : des occurrences dans scheduler.ts, server.ts, test-graph.ts, worker.ts, actions.ts et Pipeline.tsx. L'objectif est zéro occurrence.

- [ ] **Étape 2 : Supprimer côté worker**

`scheduler.ts` :
- supprimer les imports `GraphDependencies` (l.6), `emitEvent` (l.7) et `resolveVotes` (l.8), qui ne servent qu'à `triggerRecollectVotes` ;
- supprimer entièrement le JSDoc et la fonction `triggerRecollectVotes` (l.500-554) ;
- dans le commentaire de `pausedOnFromSnapshot`, remplacer « `triggerRecollectVotes` utilise `updateState(..., "waitForPlanTrigger")` pour rafraîchir confirmedPlayerIdsByTime sans faire avancer le graphe » par « `triggerRecomputePlan` utilise `updateState(..., "waitForPlanTrigger")` avant de reprendre le graphe » ;
- dans le JSDoc de `triggerRecomputePlan`, remplacer « Même mécanique que `triggerRecollectVotes` (`updateState(..., "waitForPlanTrigger")` pour faire pointer `next` sur `["bookSlots"]`), mais sans changer de données (on relit les mêmes confirmedPlayerIdsByTime) » par « `updateState(..., "waitForPlanTrigger")` fait pointer `next` sur `["bookSlots"]` (le 3ᵉ argument doit être la barrière, pas `"collectVotes"`, sinon `next` redeviendrait `["waitForPlanTrigger"]`) ».

`server.ts` :
- retirer `triggerRecollectVotes,` de l'import ;
- regex l.42 : `(send-poll|collect-votes|plan|recompute-plan|go|retry)` ;
- unions l.168 et l.387 : `"send-poll" | "collect-votes" | "plan" | "recompute-plan" | "go" | "retry"` ;
- supprimer la branche `else if (action === "recollect-votes") { … }` (l.409-410).

`resolveVotes.ts`, JSDoc : remplacer « Partagé entre le nœud CollectVotes (1er passage) et triggerRecollectVotes (relecture manuelle, cf. scheduler.ts). » par « Appelé une seule fois par job, par le nœud CollectVotes : le sondage est supprimé juste après (spec 2026-10-09), toute relecture renverrait « aucune_reponse » pour tous. »

`test-graph.ts` :
- l.67 : `(voir triggerRecollectVotes plus bas)` devient `(voir la simulation updateState plus bas)` ;
- l.269 : `'--- 2ter. updateState : Dave rejoint le groupe 19H30 (simulé) ---'` ;
- l.270-272 : `// Valide seulement le mécanisme updateState(..., "waitForPlanTrigger") (utilisé par triggerRecomputePlan, scheduler.ts) — resolveVotes() lui-même est déjà` (la suite du commentaire est inchangée).

- [ ] **Étape 3 : Supprimer côté UI et masquer `pollTally`**

- `apps/ui/src/lib/worker.ts:156` : `action: "send-poll" | "collect-votes" | "plan" | "recompute-plan" | "go" | "retry",`
- `apps/ui/src/app/actions.ts` : supprimer `triggerRecollectVotesAction` (l.263-269).
- `Pipeline.tsx` : retirer `triggerRecollectVotesAction,` de l'import (l.9) et supprimer le bloc `{stage === "awaiting-plan" && admin && ( <form action={triggerRecollectVotesAction}> … </form> )}` (l.403-410). Remplacer `{pollTally && (` (l.334) par :

```tsx
        {/* Une fois l'étape 2 faite, le sondage est supprimé : get_responses dirait « personne n'a répondu ». */}
        {pollTally && step2State(stage, values) !== "done" && (
```

- [ ] **Étape 4 : Vérifier**

Run : `grep -rn -i "recollect" apps/worker/src apps/ui/src ; npm run typecheck && npm run worker:test`
Résultat attendu : aucune ligne pour le grep, puis typecheck et tests PASS.

- [ ] **Étape 5 : Commit**

```bash
git add apps/worker/src/scheduler/scheduler.ts apps/worker/src/http/server.ts apps/worker/src/graph/resolveVotes.ts apps/worker/src/scripts/test-graph.ts apps/ui/src/lib/worker.ts apps/ui/src/app/actions.ts "apps/ui/src/app/rules/[id]/jobs/[jobId]/Pipeline.tsx"
git commit -m "refactor: retrait de « Relire les réponses », aperçu des votes masqué après la collecte

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tâche 5 : `unresolvedVoters` — résolution, état, message Telegram et synthèse

**Fichiers :**
- Modify : `apps/worker/src/graph/state.ts` (type et annotation)
- Modify : `apps/worker/src/graph/resolveVotes.ts`
- Create : `apps/worker/src/graph/unresolvedVoters.ts`
- Modify : `apps/worker/src/graph/nodes/collectVotes.ts`
- Modify : `apps/worker/src/graph/nodes/announce.ts:393-442` (`buildVoteBookingSynthesis`), `:497-508` et `:638-646` (`createAnnounceNode`)
- Modify (fixtures `PipelineStateType` complètes) : `apps/worker/src/graph/nodes/announce.test.ts`, `apps/worker/src/graph/nodes/bookSlots.test.ts`, `apps/worker/src/graph/nodes/sendPoll.test.ts`
- Test : `apps/worker/src/graph/resolveVotes.test.ts` (nouveau), `apps/worker/src/graph/unresolvedVoters.test.ts` (nouveau), `apps/worker/src/graph/nodes/collectVotes.test.ts`, `apps/worker/src/graph/nodes/announce.test.ts`

**Interfaces :**
- Produit (state.ts) : `export interface UnresolvedVoter { name: string; phone: string | null; option: string }`, et l'annotation `unresolvedVoters: UnresolvedVoter[]` (défaut `[]`).
- Produit (resolveVotes.ts) : `ResolvedVotes = { confirmedPlayerIdsByTime: Record<string, string[]>; volunteerSubstituteIds: string[]; unresolvedVoters: UnresolvedVoter[] }`. `phone` vaut `"+33…"` (même format que le `lookup_player_by_phone`), ou `null`.
- Produit (unresolvedVoters.ts) : `export function buildUnresolvedVotersMessage(ruleLabel: string, voters: UnresolvedVoter[]): string`.
- Produit (announce.ts) : `buildVoteBookingSynthesis(bookingRule, targetDate, confirmedPlayerIdsByTime, bookingPlanGroups, memberNames = {}, volunteerSubstituteIds = [], reservationFailures = [], unresolvedVoters: UnresolvedVoter[] = []): string`.

- [ ] **Étape 1 : Écrire les tests qui échouent**

Créer `apps/worker/src/graph/resolveVotes.test.ts` :

```ts
import { describe, expect, it, vi } from "vitest";
import type { GraphDependencies } from "./dependencies.js";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "./nodes/pollQuestion.js";

vi.mock("../mcp/huddleBot.js", () => ({ getResponses: vi.fn() }));
vi.mock("../mcp/resaSquash.js", () => ({ lookupPlayerByPhone: vi.fn() }));

const { resolveVotes } = await import("./resolveVotes.js");
const { getResponses } = await import("../mcp/huddleBot.js");
const { lookupPlayerByPhone } = await import("../mcp/resaSquash.js");

const deps = {
  huddleBot: { client: {} as never, close: async () => {} },
  resaSquash: { client: {} as never, close: async () => {} },
} as unknown as GraphDependencies;

describe("resolveVotes — votants non identifiés (spec 2026-10-09 §3.2)", () => {
  it("garde nom, téléphone et option des non-identifiés ; votant sans téléphone conservé avec phone null", async () => {
    vi.mocked(getResponses).mockResolvedValue({
      requestId: "poll-1",
      type: "poll",
      responses: [
        { member: "Hugo MERCIER", phone: "33600000001", statut: "10H30" },
        { member: "Vince", phone: "33663892186", statut: SUBSTITUTE_VOLUNTEER_POLL_OPTION },
        { member: "Sans Tel", phone: null, statut: "10H30" },
        { member: "Paul", phone: "33600000003", statut: "non" },
      ],
    });
    vi.mocked(lookupPlayerByPhone).mockImplementation(async (_client, phone) =>
      phone === "+33600000001" ? { found: true, userId: "u-hugo" } : { found: false },
    );

    const result = await resolveVotes(deps, "poll-1", ["10H30"]);

    expect(result).toEqual({
      confirmedPlayerIdsByTime: { "10H30": ["u-hugo"] },
      volunteerSubstituteIds: [],
      unresolvedVoters: [
        { name: "Vince", phone: "+33663892186", option: SUBSTITUTE_VOLUNTEER_POLL_OPTION },
        { name: "Sans Tel", phone: null, option: "10H30" },
      ],
    });
    expect(lookupPlayerByPhone).toHaveBeenCalledTimes(2);
  });
});
```

Créer `apps/worker/src/graph/unresolvedVoters.test.ts` :

```ts
import { describe, expect, it } from "vitest";
import { buildUnresolvedVotersMessage } from "./unresolvedVoters.js";

describe("buildUnresolvedVotersMessage (spec 2026-10-09 §3.1)", () => {
  it("liste chaque votant avec sa cause et son option, puis l'action attendue", () => {
    const text = buildUnresolvedVotersMessage("squash-samedi-matin v2", [
      { name: "Vince", phone: "+33663892186", option: "Non, mais je peux prêter mon nom" },
      { name: "Henry", phone: null, option: "10H30" },
    ]);
    expect(text).toBe(
      "[squash-samedi-matin v2] ⚠️ 2 votant(s) non identifié(s) — impossible de savoir qui c'est, exclu(s) du plan :\n" +
        "  • Vince (+33663892186, numéro inconnu de resa-squash) — « Non, mais je peux prêter mon nom »\n" +
        "  • Henry (pas de numéro WhatsApp) — « 10H30 »\n" +
        "→ Associer ce numéro à leur compte TeamR/resa-squash, puis « Recalculer le plan » avant le go.",
    );
  });
});
```

Dans `collectVotes.test.ts` :
- dans le mock de `../resolveVotes.js`, remplacer `unresolvedNames: [],` par `unresolvedVoters: [],` ;
- ajouter en tête : `vi.mock("../../telegram/telegram.js", …)` existe déjà ; récupérer `const { sendTelegramMessage } = await import("../../telegram/telegram.js");` et `const { resolveVotes } = await import("../resolveVotes.js");` ;
- ajouter ce describe en fin de fichier :

```ts
describe("createCollectVotesNode — votants non identifiés", () => {
  beforeEach(() => vi.clearAllMocks());

  it("message Telegram dédié après « Confirmés par heure », plus de suffixe « non résolu(s) », état renseigné", async () => {
    const voter = { name: "Vince", phone: "+33663892186", option: "Non, mais je peux prêter mon nom" };
    vi.mocked(resolveVotes).mockResolvedValueOnce({
      confirmedPlayerIdsByTime: { "18H45": ["u1", "u2"] },
      volunteerSubstituteIds: [],
      unresolvedVoters: [voter],
    });

    const result = await createCollectVotesNode(deps)(state(false));

    const texts = vi.mocked(sendTelegramMessage).mock.calls.map((c) => c[1]);
    expect(texts[0]).toBe("[Mardi] Confirmés par heure — 18H45 : 2.");
    expect(texts[1]).toContain("[Mardi] ⚠️ 1 votant(s) non identifié(s)");
    expect(result.unresolvedVoters).toEqual([voter]);
  });
});
```

Dans `announce.test.ts`, ajouter dans le `describe("buildVoteBookingSynthesis")` :

```ts
  it("liste les volontaires non identifiés par leur nom WhatsApp avec « ⚠️ non identifié » (spec 2026-10-09 §3.4)", () => {
    const text = buildVoteBookingSynthesis(
      rule({ candidateStartTimes: ["18H45"] }),
      "2026-07-21",
      { "18H45": ["vincent", "stephane"] },
      [group()],
      { julie: "Julie Durand" },
      ["julie"],
      [],
      [
        { name: "Thomas LECCIA", phone: "+33686870364", option: "Non, mais je peux prêter mon nom" },
        { name: "Henry", phone: null, option: "18H45" },
      ],
    );
    expect(text).toContain("Prête-noms volontaires :\nJulie Durand, Thomas LECCIA ⚠️ non identifié");
    expect(text).not.toContain("Henry ⚠️");
  });
```

- [ ] **Étape 2 : Lancer les tests (échec attendu)**

Run : `npm run worker:test -- resolveVotes.test.ts unresolvedVoters.test.ts collectVotes.test.ts announce.test.ts`
Résultat attendu : FAIL. Le module `./unresolvedVoters.js` est introuvable, `unresolvedVoters` est absent du résultat, et le suffixe « non résolu(s) » est encore présent.

- [ ] **Étape 3 : Implémenter**

`state.ts`, après `ReservationFailure` :

```ts
/** Votant (heure ou prête-nom) dont le téléphone ne correspond à aucun compte resa-squash — exclu du plan (spec 2026-10-09 §3). */
export interface UnresolvedVoter {
  /** Nom WhatsApp (`get_responses.member`). */
  name: string;
  /** "+33…" tel que cherché par `lookup_player_by_phone`, null si WhatsApp ne l'a pas fourni. */
  phone: string | null;
  /** Libellé exact de l'option votée (heure candidate ou `SUBSTITUTE_VOLUNTEER_POLL_OPTION`). */
  option: string;
}
```

Dans `PipelineState`, après `volunteerSubstituteIds` :

```ts
  /** Votants non identifiés à la collecte (spec 2026-10-09 §3.2) — `[]` pour les checkpoints antérieurs. */
  unresolvedVoters: Annotation<UnresolvedVoter[]>({ reducer: (_current, update) => update, default: () => [] }),
```

`resolveVotes.ts` :
- ajouter `import type { UnresolvedVoter } from "./state.js";` ;
- dans `ResolvedVotes`, remplacer `unresolvedNames: string[];` par `unresolvedVoters: UnresolvedVoter[];` ;
- remplacer `const unresolvedNames: string[] = [];` par `const unresolvedVoters: UnresolvedVoter[] = [];`, `unresolvedNames.push(respondent.member);` par `unresolvedVoters.push({ name: respondent.member, phone: phone ?? null, option: respondent.statut });`, et le `return` par `return { confirmedPlayerIdsByTime, volunteerSubstituteIds, unresolvedVoters };`.

Créer `apps/worker/src/graph/unresolvedVoters.ts` :

```ts
import type { UnresolvedVoter } from "./state.js";

function describeCause(voter: UnresolvedVoter): string {
  return voter.phone ? `${voter.phone}, numéro inconnu de resa-squash` : "pas de numéro WhatsApp";
}

/** Message Telegram (organisateur) envoyé à la collecte dès qu'un votant n'est pas identifié (spec 2026-10-09 §3.1). */
export function buildUnresolvedVotersMessage(ruleLabel: string, voters: UnresolvedVoter[]): string {
  const lines = voters.map((v) => `  • ${v.name} (${describeCause(v)}) — « ${v.option} »`);
  return (
    `[${ruleLabel}] ⚠️ ${voters.length} votant(s) non identifié(s) — impossible de savoir qui c'est, exclu(s) du plan :\n` +
    `${lines.join("\n")}\n` +
    "→ Associer ce numéro à leur compte TeamR/resa-squash, puis « Recalculer le plan » avant le go."
  );
}
```

`collectVotes.ts` :
- importer `import { buildUnresolvedVotersMessage } from "../unresolvedVoters.js";` ;
- déstructurer `unresolvedVoters` à la place de `unresolvedNames` (l.13) ;
- supprimer `unresolvedSuffix` (l.29-32) et le retirer du template Telegram (l.37) ;
- après cet envoi, ajouter :

```ts
    if (unresolvedVoters.length > 0) {
      await sendTelegramMessage(deps.telegram, buildUnresolvedVotersMessage(bookingRule.name ?? bookingRule.id, unresolvedVoters));
    }
```

- retourner `{ confirmedPlayerIdsByTime, volunteerSubstituteIds, unresolvedVoters }`.

`announce.ts` :
- importer `import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "./pollQuestion.js";` et ajouter `UnresolvedVoter` à l'import de types depuis `../state.js` ;
- ajouter le paramètre `unresolvedVoters: UnresolvedVoter[] = [],` à `buildVoteBookingSynthesis` après `reservationFailures` ;
- remplacer `const volunteersBlock = volunteerSubstituteIds.map(displayName).join(", ");` par :

```ts
  // Volontaires sans compte resa-squash : nom WhatsApp + ⚠️ (message de debug, groupe test uniquement — spec 2026-10-09 §3.4).
  const unresolvedVolunteers = unresolvedVoters
    .filter((v) => v.option === SUBSTITUTE_VOLUNTEER_POLL_OPTION)
    .map((v) => `${v.name} ⚠️ non identifié`);
  const volunteersBlock = [...volunteerSubstituteIds.map(displayName), ...unresolvedVolunteers].join(", ");
```

- dans `createAnnounceNode`, ajouter `unresolvedVoters,` à la déstructuration de `state` (l.499-508) et passer `reservationFailures, unresolvedVoters ?? [],` comme deux derniers arguments de `buildVoteBookingSynthesis` (l.638-646).

- [ ] **Étape 4 : Compléter les fixtures**

Run : `npm run worker:typecheck`
Résultat attendu : FAIL avec « Property 'unresolvedVoters' is missing » dans `announce.test.ts`, `bookSlots.test.ts` et `sendPoll.test.ts`. Dans chaque littéral `PipelineStateType` signalé, ajouter `unresolvedVoters: [],` après `volunteerSubstituteIds: …,`.

- [ ] **Étape 5 : Relancer les tests (PASS attendu)**

Run : `npm run worker:typecheck && npm run worker:test`
Résultat attendu : PASS.

- [ ] **Étape 6 : Commit**

```bash
git add apps/worker/src/graph apps/worker/src/graph/nodes
git commit -m "feat(worker): votants non identifiés conservés dans l'état et signalés sur Telegram

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tâche 6 : Date de clôture dans la question du sondage

**Fichiers :**
- Modify : `apps/worker/src/graph/nodes/pollQuestion.ts:1-72`
- Modify : `apps/worker/src/graph/nodes/sendPoll.ts:49`
- Modify : `apps/ui/src/lib/pipelinePreview.ts`, `apps/ui/src/app/rules/[id]/jobs/[jobId]/page.tsx:110`
- Test : `apps/worker/src/graph/nodes/pollQuestion.test.ts`, `apps/worker/src/graph/nodes/sendPoll.test.ts`, `apps/ui/src/lib/pipelinePreview.test.ts` (nouveau)

**Interfaces :**
- Produit (pollQuestion.ts) : `export function formatSessionTime(sessionStartTime: string): string` et `export function formatInformalDate(targetDate: string): string` (désormais exportées) ; `export function formatPollClosureDeadline(targetDate: string, decisionDaysBefore: number, decisionTime: string, now: Date): string | null` (null si la clôture est déjà passée ou si `decisionTime` est invalide) ; `buildPollQuestion(targetDate: string, candidateStartTimes: string[], closedTimes: string[] = [], closureDeadline: string | null = null): string`.
- Produit (pipelinePreview.ts) : `export interface PollClosureSettings { decisionDaysBefore: number; decisionTime: string }` et `buildPollQuestionPreview(targetDate: string, candidateStartTimes: string[], closure?: PollClosureSettings, now: Date = new Date()): string`.

- [ ] **Étape 1 : Écrire les tests qui échouent**

Dans `pollQuestion.test.ts`, ajouter `formatPollClosureDeadline` à l'import puis :

```ts
describe("clôture du sondage (spec 2026-10-09 §1.1)", () => {
  // samedi 10 octobre 2026, Paris = UTC+2
  it("date cible − decisionDaysBefore, heure decisionTime au format « 9h »", () => {
    expect(formatPollClosureDeadline("2026-10-10", 5, "09:00", new Date("2026-10-03T08:00:00Z"))).toBe("lundi 5 octobre à 9h");
    expect(formatPollClosureDeadline("2026-10-10", 5, "21:30", new Date("2026-10-03T08:00:00Z"))).toBe("lundi 5 octobre à 21h30");
  });

  it("decisionDaysBefore = 0 : le jour affiché est le jour du match", () => {
    expect(formatPollClosureDeadline("2026-10-10", 0, "08:00", new Date("2026-10-09T10:00:00Z"))).toBe("samedi 10 octobre à 8h");
  });

  it("clôture déjà passée à l'envoi : mention omise (null)", () => {
    expect(formatPollClosureDeadline("2026-10-10", 5, "09:00", new Date("2026-10-05T07:00:00Z"))).toBeNull(); // 9h00 Paris
    expect(formatPollClosureDeadline("2026-10-10", 5, "09:00", new Date("2026-10-05T06:59:00Z"))).toBe("lundi 5 octobre à 9h");
  });

  it("question : la clôture vient en dernier, après « puc fermé »", () => {
    expect(buildPollQuestion("2026-10-10", ["10H30"], [], "lundi 5 octobre à 9h")).toBe(
      "Squash samedi 10 octobre à 10h30 ? (réponses jusqu'au lundi 5 octobre à 9h)",
    );
    expect(buildPollQuestion("2026-10-10", ["10H30"], ["9H45"], "lundi 5 octobre à 9h")).toBe(
      "Squash samedi 10 octobre à 10h30 ? (9h45 : puc fermé) (réponses jusqu'au lundi 5 octobre à 9h)",
    );
    expect(buildPollQuestion("2026-10-10", ["10H30"], [], null)).toBe("Squash samedi 10 octobre à 10h30 ?");
  });
});
```

Dans `sendPoll.test.ts`, ajouter `afterEach` à l'import vitest puis, dans `describe("createSendPollNode")` :

```ts
  describe("clôture annoncée (spec 2026-10-09 §1.1)", () => {
    afterEach(() => vi.useRealTimers());

    it("ajoute la clôture lue sur la règle (decisionDaysBefore=7, decisionTime=21:30)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-07T08:00:00Z"));

      await createSendPollNode(deps([]))(state());

      expect(askPoll).toHaveBeenCalledWith(
        expect.anything(),
        "group@test",
        "Squash samedi 15 août, à quelle heure : 18h45 ou 19h30 ? (réponses jusqu'au samedi 8 août à 21h30)",
        ["18H45", "19H30", "Non", "Non, mais je peux prêter mon nom"],
      );
    });
  });
```

Créer `apps/ui/src/lib/pipelinePreview.test.ts` :

```ts
import { describe, expect, it } from "vitest";
import { buildPollQuestionPreview } from "./pipelinePreview";

describe("buildPollQuestionPreview — clôture (spec 2026-10-09 §1.1)", () => {
  const closure = { decisionDaysBefore: 5, decisionTime: "09:00" };

  it("ajoute la clôture comme le worker", () => {
    expect(buildPollQuestionPreview("2026-10-10", ["10H30"], closure, new Date("2026-10-03T08:00:00Z"))).toBe(
      "Squash samedi 10 octobre à 10h30 ? (réponses jusqu'au lundi 5 octobre à 9h)",
    );
  });

  it("decisionDaysBefore = 0", () => {
    expect(
      buildPollQuestionPreview("2026-10-10", ["10H30"], { decisionDaysBefore: 0, decisionTime: "08:00" }, new Date("2026-10-09T10:00:00Z")),
    ).toBe("Squash samedi 10 octobre à 10h30 ? (réponses jusqu'au samedi 10 octobre à 8h)");
  });

  it("clôture passée ou réglage absent : pas de mention", () => {
    expect(buildPollQuestionPreview("2026-10-10", ["10H30"], closure, new Date("2026-10-05T07:00:00Z"))).toBe(
      "Squash samedi 10 octobre à 10h30 ?",
    );
    expect(buildPollQuestionPreview("2026-10-10", ["10H30"])).toBe("Squash samedi 10 octobre à 10h30 ?");
  });
});
```

- [ ] **Étape 2 : Lancer les tests (échec attendu)**

Run : `npm run worker:test -- pollQuestion.test.ts sendPoll.test.ts ; npm run test -w @squash-assistant/ui -- pipelinePreview.test.ts`
Résultat attendu : FAIL. `formatPollClosureDeadline` n'est pas exporté, et la question ne contient pas « réponses jusqu'au ».

- [ ] **Étape 3 : Implémenter**

`pollQuestion.ts` :
- préfixer par `export` les fonctions `formatSessionTime` (l.7) et `formatInformalDate` (l.17) ;
- après `formatSessionTimeList`, ajouter :

```ts
/** "09:00" -> "9h", "21:30" -> "21h30" (decisionTime est déjà en heure de Paris). */
function formatClockTime(hhmm: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return hhmm;
  const hour = Number(match[1]);
  return match[2] === "00" ? `${hour}h` : `${hour}h${match[2]}`;
}

function shiftDate(ymd: string, daysBefore: number): string {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - daysBefore);
  return date.toISOString().slice(0, 10);
}

/** Date calendaire et minutes depuis minuit, heure murale de Paris (jamais le fuseau du pod). */
function parisWallClock(now: Date): { date: string; minutes: number } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return { date, minutes: hour * 60 + minute };
}

/**
 * « lundi 5 octobre à 9h » : date cible − `decisionDaysBefore`, à `decisionTime` (spec 2026-10-09 §1.1).
 * null si cette clôture est déjà passée à `now` (job manuel tardif) ou si `decisionTime` est invalide.
 */
export function formatPollClosureDeadline(
  targetDate: string,
  decisionDaysBefore: number,
  decisionTime: string,
  now: Date,
): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(decisionTime.trim());
  if (!match) return null;
  const deadlineMinutes = Number(match[1]) * 60 + Number(match[2]);
  const deadlineDate = shiftDate(targetDate, decisionDaysBefore);
  const { date: today, minutes } = parisWallClock(now);
  if (deadlineDate < today || (deadlineDate === today && minutes >= deadlineMinutes)) return null;
  return `${formatInformalDate(deadlineDate)} à ${formatClockTime(decisionTime)}`;
}
```

- remplacer `buildPollQuestion` (l.59-72) par :

```ts
export function buildPollQuestion(
  targetDate: string,
  candidateStartTimes: string[],
  closedTimes: string[] = [],
  closureDeadline: string | null = null,
): string {
  const timeLabel = formatSessionTimeList(candidateStartTimes);
  const base =
    candidateStartTimes.length > 1
      ? `Squash ${formatInformalDate(targetDate)}, à quelle heure : ${timeLabel} ?`
      : `Squash ${formatInformalDate(targetDate)} à ${timeLabel} ?`;
  const closedPart = closedTimes.length > 0 ? ` (${closedTimes.map(formatSessionTime).join(", ")} : puc fermé)` : "";
  const closurePart = closureDeadline ? ` (réponses jusqu'au ${closureDeadline})` : "";
  return `${base}${closedPart}${closurePart}`;
}
```

`sendPoll.ts` : importer `formatPollClosureDeadline` depuis `./pollQuestion.js`. `bookingRule` est la règle live au moment de l'envoi (`triggerSendPoll` passe la règle chargée en base). Remplacer l.49 par :

```ts
        const closureDeadline = formatPollClosureDeadline(
          targetDate,
          bookingRule.decisionDaysBefore,
          bookingRule.decisionTime,
          new Date(),
        );
        const question = buildPollQuestion(targetDate, openTimes, closedTimes, closureDeadline);
```

`apps/ui/src/lib/pipelinePreview.ts` : ajouter après `formatInformalDate` les mêmes `formatClockTime`, `shiftDate`, `parisWallClock` et `formatPollClosureDeadline` que ci-dessus (copie volontaire, comme le reste du fichier). Changer seulement `export function formatPollClosureDeadline` en `function formatPollClosureDeadline`. Puis remplacer `buildPollQuestionPreview` par :

```ts
export interface PollClosureSettings {
  decisionDaysBefore: number;
  decisionTime: string;
}

export function buildPollQuestionPreview(
  targetDate: string,
  candidateStartTimes: string[],
  closure?: PollClosureSettings,
  now: Date = new Date(),
): string {
  const timeLabel = formatSessionTimeList(candidateStartTimes);
  const base =
    candidateStartTimes.length > 1
      ? `Squash ${formatInformalDate(targetDate)}, à quelle heure : ${timeLabel} ?`
      : `Squash ${formatInformalDate(targetDate)} à ${timeLabel} ?`;
  const deadline = closure
    ? formatPollClosureDeadline(targetDate, closure.decisionDaysBefore, closure.decisionTime, now)
    : null;
  return deadline ? `${base} (réponses jusqu'au ${deadline})` : base;
}
```

`page.tsx:110` :

```tsx
        pollQuestionPreview={buildPollQuestionPreview(job.targetDate, effectiveCandidateStartTimes, {
          decisionDaysBefore: rule.decisionDaysBefore,
          decisionTime: rule.decisionTime,
        })}
```

- [ ] **Étape 4 : Relancer les tests (PASS attendu)**

Run : `npm run worker:test -- pollQuestion.test.ts sendPoll.test.ts && npm run test -w @squash-assistant/ui && npm run typecheck`
Résultat attendu : PASS. Les tests `sendPoll` existants (août 2026, clôture passée) restent inchangés.

- [ ] **Étape 5 : Commit**

```bash
git add apps/worker/src/graph/nodes/pollQuestion.ts apps/worker/src/graph/nodes/pollQuestion.test.ts apps/worker/src/graph/nodes/sendPoll.ts apps/worker/src/graph/nodes/sendPoll.test.ts apps/ui/src/lib/pipelinePreview.ts apps/ui/src/lib/pipelinePreview.test.ts "apps/ui/src/app/rules/[id]/jobs/[jobId]/page.tsx"
git commit -m "feat(sondage): date de clôture des réponses dans la question et l'aperçu UI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tâche 7 : Schéma, migration 0033 et helpers `job_runs` / événements

**Fichiers :**
- Modify : `packages/db/src/schema.ts:211-213` (table `jobRuns`)
- Create (généré) : `packages/db/src/migrations/0033_poll_closure_recap.sql`, `packages/db/src/migrations/meta/0033_snapshot.json`, et une modification de `meta/_journal.json`
- Modify : `apps/worker/src/jobRuns.ts`
- Modify : `apps/worker/src/graph/emitEvent.ts`
- Modify (fixtures `JobRun` complètes) : `apps/worker/src/scheduler/scheduler.test.ts`, `apps/worker/src/scheduler/startReminder.test.ts`, `apps/worker/src/closures/closureImpact.test.ts`
- Test : typecheck (helpers SQL sans test unitaire, comme les helpers existants de `jobRuns.ts`). Ils sont exercés par les tests des tâches 9 à 11 via des mocks.

**Interfaces :**
- Produit (schéma) : `JobRun.pollClosedAt: Date | null`, `JobRun.recapMsgId: string | null`, `JobRun.recapJid: string | null`.
- Produit (jobRuns.ts) :
  - `setJobRunPollClosedAt(db: Database, jobId: string): Promise<void>`
  - `setJobRunRecapInfo(db: Database, jobId: string, recap: { msgId: string; jid: string } | null): Promise<void>`
  - `findPreviousPinnedRecap(db: Database, bookingRuleId: string, excludeJobId: string): Promise<{ jobId: string; msgId: string; jid: string } | undefined>`
  - `listJobRunsWithPinnedRecap(db: Database, upToDate: string): Promise<JobRun[]>` (récap épinglé ET (`targetDate <= upToDate` OU job annulé))
- Produit (emitEvent.ts) : `findLastSuccessfulEventDetail(db: Database, jobRunId: string, type: EventType): Promise<unknown>` (undefined s'il n'y a aucun événement).

- [ ] **Étape 1 : Ajouter les colonnes**

`schema.ts`, table `jobRuns`, juste après `announceJid: text("announce_jid"),` :

```ts
  /** Sondage supprimé à la collecte (étape 2) — ne jamais le relire : get_responses renverrait « aucune_reponse » (ADR-037). */
  pollClosedAt: timestamp("poll_closed_at"),
  /** Récap des inscrits épinglé (étape 2) — désépinglé le jour du match ou à l'annulation, oublié si le désépinglage réussit (ADR-037). */
  recapMsgId: text("recap_msg_id"),
  recapJid: text("recap_jid"),
```

- [ ] **Étape 2 : Générer la migration**

Run : `(cd packages/db && npm run db:generate -- --name poll_closure_recap)`
Résultat attendu : `packages/db/src/migrations/0033_poll_closure_recap.sql` contient exactement trois `ALTER TABLE "job_runs" ADD COLUMN` : `"poll_closed_at" timestamp`, `"recap_msg_id" text`, `"recap_jid" text`. On obtient aussi `meta/0033_snapshot.json` et une entrée `idx: 33` dans `_journal.json`. Vérifiez qu'il n'y a rien d'autre dans le SQL. En dev local seulement, `npm run db:migrate` l'applique. En prod, l'initContainer s'en charge (ADR-012).

- [ ] **Étape 3 : Reconstruire `packages/db` et lister les fixtures incomplètes**

Run : `(cd packages/db && npm run build) && npm run worker:typecheck`
Résultat attendu : FAIL avec « Property 'pollClosedAt' is missing… » dans `scheduler.test.ts`, `startReminder.test.ts` et `closureImpact.test.ts`. Dans chaque fabrique / littéral `JobRun` signalé, ajouter après `startReminderSentAt: …,` :

```ts
    pollClosedAt: null,
    recapMsgId: null,
    recapJid: null,
```

- [ ] **Étape 4 : Helpers**

`jobRuns.ts` : compléter l'import Drizzle en `import { and, desc, eq, gte, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm";` puis ajouter après `findPreviousPinnedAnnounce` :

```ts
/** Sondage supprimé à la collecte (spec 2026-10-09) — `new Date()` côté Drizzle, jamais `now()` SQL. */
export async function setJobRunPollClosedAt(db: Database, jobId: string): Promise<void> {
  await db.update(jobRuns).set({ pollClosedAt: new Date() }).where(eq(jobRuns.id, jobId));
}

export async function setJobRunRecapInfo(
  db: Database,
  jobId: string,
  recap: { msgId: string; jid: string } | null,
): Promise<void> {
  await db
    .update(jobRuns)
    .set({ recapMsgId: recap?.msgId ?? null, recapJid: recap?.jid ?? null })
    .where(eq(jobRuns.id, jobId));
}

/** Dernier récap encore épinglé de la règle (hors job courant) — à désépingler au sondage suivant. */
export async function findPreviousPinnedRecap(
  db: Database,
  bookingRuleId: string,
  excludeJobId: string,
): Promise<{ jobId: string; msgId: string; jid: string } | undefined> {
  const [job] = await db
    .select({ jobId: jobRuns.id, msgId: jobRuns.recapMsgId, jid: jobRuns.recapJid })
    .from(jobRuns)
    .where(
      and(
        eq(jobRuns.bookingRuleId, bookingRuleId),
        ne(jobRuns.id, excludeJobId),
        isNotNull(jobRuns.recapMsgId),
        isNotNull(jobRuns.recapJid),
      ),
    )
    .orderBy(desc(jobRuns.createdAt))
    .limit(1);
  return job?.msgId && job.jid ? { jobId: job.jobId, msgId: job.msgId, jid: job.jid } : undefined;
}

/**
 * Récaps épinglés à examiner par le tick à la minute : match aujourd'hui ou passé (rattrapage),
 * ou job annulé dont le désépinglage immédiat a échoué. Aucun filtre sur la règle (désactivée,
 * rappel désactivé) : un récap épinglé doit toujours finir désépinglé.
 */
export async function listJobRunsWithPinnedRecap(db: Database, upToDate: string): Promise<JobRun[]> {
  return db
    .select()
    .from(jobRuns)
    .where(
      and(
        isNotNull(jobRuns.recapMsgId),
        isNotNull(jobRuns.recapJid),
        or(lte(jobRuns.targetDate, upToDate), isNotNull(jobRuns.cancelledAt)),
      ),
    );
}
```

`emitEvent.ts` : remplacer l'import de schéma par `import { events, type EventStatus, type EventType } from "@squash-assistant/db/schema";` (inchangé) et ajouter `import { and, desc, eq } from "drizzle-orm";`, puis en fin de fichier :

```ts
/** `detail` du dernier événement réussi de ce type pour le job — sert à reprendre les votes d'un sondage déjà fermé. */
export async function findLastSuccessfulEventDetail(db: Database, jobRunId: string, type: EventType): Promise<unknown> {
  const [row] = await db
    .select({ detail: events.detail })
    .from(events)
    .where(and(eq(events.jobRunId, jobRunId), eq(events.type, type), eq(events.status, "success")))
    .orderBy(desc(events.createdAt))
    .limit(1);
  return row?.detail;
}
```

- [ ] **Étape 5 : Vérifier**

Run : `npm run typecheck && npm test`
Résultat attendu : PASS (aucun changement de comportement).

- [ ] **Étape 6 : Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/migrations apps/worker/src/jobRuns.ts apps/worker/src/graph/emitEvent.ts apps/worker/src/scheduler/scheduler.test.ts apps/worker/src/scheduler/startReminder.test.ts apps/worker/src/closures/closureImpact.test.ts
git commit -m "feat(db): colonnes de clôture du sondage et du récap épinglé (migration 0033)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tâche 8 : Message du récap des inscrits (fonction pure)

**Fichiers :**
- Create : `apps/worker/src/graph/nodes/registrationRecap.ts`
- Test : `apps/worker/src/graph/nodes/registrationRecap.test.ts` (nouveau)

**Interfaces :**
- Consomme : `formatInformalDate(targetDate: string): string`, `formatSessionTime(sessionStartTime: string): string`, `SUBSTITUTE_VOLUNTEER_POLL_OPTION` (pollQuestion.ts, exportés en tâche 6) ; `UnresolvedVoter` (state.ts, tâche 5).
- Produit : `export interface RegistrationRecapInput { targetDate: string; candidateStartTimes: string[]; confirmedPlayerIdsByTime: Record<string, string[]>; volunteerSubstituteIds: string[]; unresolvedVoters: UnresolvedVoter[]; memberNames: Record<string, string> }` et `export function buildRegistrationRecapMessage(input: RegistrationRecapInput): string`.

- [ ] **Étape 1 : Écrire le test qui échoue**

Créer `registrationRecap.test.ts` :

```ts
import { describe, expect, it } from "vitest";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "./pollQuestion.js";
import { buildRegistrationRecapMessage, type RegistrationRecapInput } from "./registrationRecap.js";

const names = { u1: "Hugo MERCIER", u2: "Vincent LACOSTE", u3: "Gaëtan COATANROCH", u4: "Martin MERLOT", u5: "Julie DURAND" };

function input(overrides: Partial<RegistrationRecapInput> = {}): RegistrationRecapInput {
  return {
    targetDate: "2026-10-10",
    candidateStartTimes: ["10H30"],
    confirmedPlayerIdsByTime: { "10H30": ["u1", "u2", "u3", "u4"] },
    volunteerSubstituteIds: [],
    unresolvedVoters: [],
    memberNames: names,
    ...overrides,
  };
}

describe("buildRegistrationRecapMessage (spec 2026-10-09 §2.1)", () => {
  it("cas du job 04578758 : une heure, deux prête-noms non identifiés remerciés par leur nom WhatsApp", () => {
    const text = buildRegistrationRecapMessage(
      input({
        unresolvedVoters: [
          { name: "Thomas LECCIA", phone: "+33686870364", option: SUBSTITUTE_VOLUNTEER_POLL_OPTION },
          { name: "Vince", phone: "+33663892186", option: SUBSTITUTE_VOLUNTEER_POLL_OPTION },
        ],
      }),
    );
    expect(text).toBe(
      "🔒 Inscriptions closes — samedi 10 octobre 🎾\n" +
        "⏰ 10h30 (4) : Hugo MERCIER, Vincent LACOSTE, Gaëtan COATANROCH, Martin MERLOT\n" +
        "🙏 Merci à Thomas LECCIA et Vince pour les prête-noms :)\n" +
        "Les courts arrivent bientôt 😉",
    );
  });

  it("plusieurs heures (seules celles avec inscrits), un seul prête-nom identifié, votant non identifié compté à son heure", () => {
    const text = buildRegistrationRecapMessage(
      input({
        candidateStartTimes: ["9H45", "10H30", "11H15"],
        confirmedPlayerIdsByTime: { "9H45": ["u1", "u2"], "10H30": [], "11H15": ["u3"] },
        volunteerSubstituteIds: ["u5"],
        unresolvedVoters: [{ name: "Henry", phone: null, option: "11H15" }],
      }),
    );
    expect(text).toBe(
      "🔒 Inscriptions closes — samedi 10 octobre 🎾\n" +
        "⏰ 9h45 (2) : Hugo MERCIER, Vincent LACOSTE\n" +
        "⏰ 11h15 (2) : Gaëtan COATANROCH, Henry\n" +
        "🙏 Merci à Julie DURAND pour le prête-nom :)\n" +
        "Les courts arrivent bientôt 😉",
    );
  });

  it("trois prête-noms : « A, B et C »", () => {
    const text = buildRegistrationRecapMessage(input({ volunteerSubstituteIds: ["u5"], unresolvedVoters: [
      { name: "Thomas", phone: null, option: SUBSTITUTE_VOLUNTEER_POLL_OPTION },
      { name: "Vince", phone: null, option: SUBSTITUTE_VOLUNTEER_POLL_OPTION },
    ] }));
    expect(text).toContain("🙏 Merci à Julie DURAND, Thomas et Vince pour les prête-noms :)");
  });

  it("aucun inscrit : message court, pas de ligne sur les courts", () => {
    const text = buildRegistrationRecapMessage(input({ confirmedPlayerIdsByTime: { "10H30": [] }, volunteerSubstituteIds: ["u5"] }));
    expect(text).toBe("🔒 Inscriptions closes — samedi 10 octobre\nPersonne cette semaine 😢");
  });

  it("aucun ⚠️ ni téléphone côté WhatsApp", () => {
    const text = buildRegistrationRecapMessage(
      input({ unresolvedVoters: [{ name: "Vince", phone: "+33663892186", option: "10H30" }] }),
    );
    expect(text).not.toContain("⚠️");
    expect(text).not.toContain("+33");
  });
});
```

- [ ] **Étape 2 : Lancer le test (échec attendu)**

Run : `npm run worker:test -- registrationRecap.test.ts`
Résultat attendu : FAIL. Le module `./registrationRecap.js` est introuvable.

- [ ] **Étape 3 : Implémenter**

Créer `registrationRecap.ts` :

```ts
import type { UnresolvedVoter } from "../state.js";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION, formatInformalDate, formatSessionTime } from "./pollQuestion.js";

export interface RegistrationRecapInput {
  targetDate: string;
  candidateStartTimes: string[];
  confirmedPlayerIdsByTime: Record<string, string[]>;
  volunteerSubstituteIds: string[];
  unresolvedVoters: UnresolvedVoter[];
  /** userId → nom resa-squash (best-effort) ; un non-identifié garde son nom WhatsApp. */
  memberNames: Record<string, string>;
}

/** ["A"] → "A", ["A","B"] → "A et B", ["A","B","C"] → "A, B et C". */
function joinFrench(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

/**
 * Récap WhatsApp des inscrits, envoyé à la collecte (spec 2026-10-09 §2.1) : concis, sans détail
 * technique ni ⚠️. Une ligne par heure ayant au moins un inscrit, remerciement des prête-noms
 * (identifiés ou non), puis l'annonce des courts qui suit.
 */
export function buildRegistrationRecapMessage(input: RegistrationRecapInput): string {
  const displayName = (userId: string): string => input.memberNames[userId] ?? userId;
  const date = formatInformalDate(input.targetDate);

  const timeLines = input.candidateStartTimes
    .map((time) => {
      const names = [
        ...(input.confirmedPlayerIdsByTime[time] ?? []).map(displayName),
        ...input.unresolvedVoters.filter((v) => v.option === time).map((v) => v.name),
      ];
      return names.length > 0 ? `⏰ ${formatSessionTime(time)} (${names.length}) : ${names.join(", ")}` : null;
    })
    .filter((line): line is string => line !== null);

  if (timeLines.length === 0) return `🔒 Inscriptions closes — ${date}\nPersonne cette semaine 😢`;

  const volunteers = [
    ...input.volunteerSubstituteIds.map(displayName),
    ...input.unresolvedVoters.filter((v) => v.option === SUBSTITUTE_VOLUNTEER_POLL_OPTION).map((v) => v.name),
  ];
  const thanks =
    volunteers.length === 0
      ? []
      : [`🙏 Merci à ${joinFrench(volunteers)} pour ${volunteers.length === 1 ? "le prête-nom" : "les prête-noms"} :)`];

  return [`🔒 Inscriptions closes — ${date} 🎾`, ...timeLines, ...thanks, "Les courts arrivent bientôt 😉"].join("\n");
}
```

- [ ] **Étape 4 : Relancer le test (PASS attendu)**

Run : `npm run worker:test -- registrationRecap.test.ts`
Résultat attendu : PASS.

- [ ] **Étape 5 : Commit**

```bash
git add apps/worker/src/graph/nodes/registrationRecap.ts apps/worker/src/graph/nodes/registrationRecap.test.ts
git commit -m "feat(worker): message WhatsApp du récap des inscrits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tâche 9 : Nœud CollectVotes — lecture, suppression, clôture, messages non bloquants

**Fichiers :**
- Modify (réécriture) : `apps/worker/src/graph/nodes/collectVotes.ts`
- Test (réécriture) : `apps/worker/src/graph/nodes/collectVotes.test.ts`

**Interfaces :**
- Consomme :
  - `getJobRunById`, `setJobRunPollClosedAt(db, jobId)`, `setJobRunRecapInfo(db, jobId, recap | null)` (jobRuns.ts, tâche 7)
  - `deleteMessage(client, jid, msgId)` et `sendMessage(client, jid, text): Promise<{ msgId?: string }>` (huddleBot.ts)
  - `withEventLogging`, `findLastSuccessfulEventDetail(db, jobRunId, "collect_votes")` (emitEvent.ts)
  - `pinBestEffort(deps, label, jid, msgId, what)`, `unpinBestEffort(...)`: `Promise<boolean>` (pinning.ts)
  - `resolveVotes(deps, pollRequestId, candidateStartTimes): Promise<ResolvedVotes>`
  - `buildUnresolvedVotersMessage(label, voters)` (tâche 5)
  - `fetchMemberNames(resaSquash, groupId)` et `resolveAnnounceNotifyJid(deps, bookingRule): Promise<string>` (announce.ts)
  - `buildRegistrationRecapMessage(input)` (tâche 8)
- Produit : `export const POLL_CLOSURE_SINCE: Date` et `createCollectVotesNode(deps: GraphDependencies)`, qui retourne `{ confirmedPlayerIdsByTime, volunteerSubstituteIds, unresolvedVoters }`.

- [ ] **Étape 1 : Écrire les tests qui échouent**

Remplacer tout le contenu de `collectVotes.test.ts` par :

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType, UnresolvedVoter } from "../state.js";

vi.mock("../resolveVotes.js", () => ({ resolveVotes: vi.fn() }));
vi.mock("../../jobRuns.js", () => ({
  getJobRunById: vi.fn(),
  setJobRunPollClosedAt: vi.fn(),
  setJobRunRecapInfo: vi.fn(),
}));
vi.mock("../../mcp/huddleBot.js", () => ({ deleteMessage: vi.fn(), sendMessage: vi.fn() }));
vi.mock("../pinning.js", () => ({ pinBestEffort: vi.fn(), unpinBestEffort: vi.fn() }));
vi.mock("../../telegram/telegram.js", () => ({ sendTelegramMessage: vi.fn() }));
vi.mock("../emitEvent.js", () => ({
  withEventLogging: vi.fn(async (_deps, _event, action) => (await action()).result),
  findLastSuccessfulEventDetail: vi.fn(),
}));
vi.mock("./announce.js", () => ({ fetchMemberNames: vi.fn(), resolveAnnounceNotifyJid: vi.fn() }));

const { createCollectVotesNode, POLL_CLOSURE_SINCE } = await import("./collectVotes.js");
const { resolveVotes } = await import("../resolveVotes.js");
const { getJobRunById, setJobRunPollClosedAt, setJobRunRecapInfo } = await import("../../jobRuns.js");
const { deleteMessage, sendMessage } = await import("../../mcp/huddleBot.js");
const { pinBestEffort, unpinBestEffort } = await import("../pinning.js");
const { sendTelegramMessage } = await import("../../telegram/telegram.js");
const { findLastSuccessfulEventDetail } = await import("../emitEvent.js");
const { fetchMemberNames, resolveAnnounceNotifyJid } = await import("./announce.js");

const deps = {
  huddleBot: { client: {} as never, close: async () => {} },
  resaSquash: { client: {} as never, close: async () => {} },
  telegram: { botToken: "t", chatId: "c" },
  db: {} as never,
} as unknown as GraphDependencies;

const VOTES = {
  confirmedPlayerIdsByTime: { "10H30": ["u1", "u2"] },
  volunteerSubstituteIds: [] as string[],
  unresolvedVoters: [] as UnresolvedVoter[],
};

function job(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: "job-1",
    bookingRuleId: "test-rule",
    targetDate: "2026-10-10",
    pollMsgId: "poll-msg-1",
    pollClosedAt: null,
    createdAt: new Date(POLL_CLOSURE_SINCE.getTime() + 1),
    ...overrides,
  } as JobRun;
}

function state(pinMessagesEnabled = false): PipelineStateType {
  return {
    bookingRule: {
      id: "test-rule",
      name: "Samedi",
      whatsappGroupJid: "group@test",
      resaSquashGroupId: "resa-1",
      candidateStartTimes: ["10H30"],
      pinMessagesEnabled,
    } as unknown as BookingRule,
    jobRunId: "job-1",
    targetDate: "2026-10-10",
    pollRequestId: "poll-1",
  } as PipelineStateType;
}

const telegramTexts = () => vi.mocked(sendTelegramMessage).mock.calls.map((c) => String(c[1]));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveVotes).mockResolvedValue(VOTES);
  vi.mocked(getJobRunById).mockResolvedValue(job());
  vi.mocked(setJobRunPollClosedAt).mockResolvedValue(undefined);
  vi.mocked(setJobRunRecapInfo).mockResolvedValue(undefined);
  vi.mocked(deleteMessage).mockResolvedValue(undefined);
  vi.mocked(sendMessage).mockResolvedValue({ msgId: "recap-1" });
  vi.mocked(pinBestEffort).mockResolvedValue(undefined);
  vi.mocked(unpinBestEffort).mockResolvedValue(true);
  vi.mocked(sendTelegramMessage).mockResolvedValue(undefined);
  vi.mocked(findLastSuccessfulEventDetail).mockResolvedValue(undefined);
  vi.mocked(fetchMemberNames).mockResolvedValue({ u1: "Hugo MERCIER", u2: "Vincent LACOSTE" });
  vi.mocked(resolveAnnounceNotifyJid).mockResolvedValue("group@test");
});

describe("createCollectVotesNode — clôture du sondage (spec 2026-10-09 §1.2)", () => {
  it("ordre : lecture → suppression → poll_closed_at → messages", async () => {
    const calls: string[] = [];
    vi.mocked(resolveVotes).mockImplementation(async () => { calls.push("read"); return VOTES; });
    vi.mocked(deleteMessage).mockImplementation(async () => { calls.push("delete"); });
    vi.mocked(setJobRunPollClosedAt).mockImplementation(async () => { calls.push("closed"); });
    vi.mocked(sendTelegramMessage).mockImplementation(async () => { calls.push("telegram"); });
    vi.mocked(sendMessage).mockImplementation(async () => { calls.push("recap"); return { msgId: "recap-1" }; });

    const result = await createCollectVotesNode(deps)(state());

    expect(calls).toEqual(["read", "delete", "closed", "telegram", "recap"]);
    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, "group@test", "poll-msg-1");
    expect(setJobRunPollClosedAt).toHaveBeenCalledWith(deps.db, "job-1");
    expect(result).toEqual(VOTES);
  });

  it("lecture en échec : rien n'est supprimé, l'étape échoue", async () => {
    vi.mocked(resolveVotes).mockRejectedValue(new Error("huddle-bot down"));

    await expect(createCollectVotesNode(deps)(state(true))).rejects.toThrow("huddle-bot down");
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
  });

  it("suppression en échec : Telegram, désépinglage tenté, poll_closed_at null, étape réussie", async () => {
    vi.mocked(deleteMessage).mockRejectedValue(new Error("boom"));

    const result = await createCollectVotesNode(deps)(state(true));

    expect(result).toEqual(VOTES);
    expect(telegramTexts()).toContain("[Samedi] Suppression du sondage échouée : boom");
    expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "poll-msg-1", "du sondage");
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
  });

  it("sondage supprimé : pas de désépinglage explicite (il part avec le message)", async () => {
    await createCollectVotesNode(deps)(state(true));
    expect(unpinBestEffort).not.toHaveBeenCalled();
  });

  it("écriture de poll_closed_at en échec : Telegram, étape réussie (pas de relance qui relirait un sondage vide)", async () => {
    vi.mocked(setJobRunPollClosedAt).mockRejectedValue(new Error("pg down"));

    const result = await createCollectVotesNode(deps)(state());

    expect(result).toEqual(VOTES);
    expect(telegramTexts().some((t) => t.startsWith("[Samedi] Sondage supprimé mais clôture non enregistrée") && t.includes("pg down"))).toBe(true);
  });

  it("Telegram et récap en échec après suppression : étape réussie", async () => {
    vi.mocked(sendTelegramMessage).mockRejectedValue(new Error("telegram down"));
    vi.mocked(sendMessage).mockRejectedValue(new Error("whatsapp down"));

    await expect(createCollectVotesNode(deps)(state())).resolves.toEqual(VOTES);
  });

  it("relance avec poll_closed_at : votes repris de l'événement collect_votes, get_responses jamais appelé", async () => {
    const voter = { name: "Vince", phone: "+33663892186", option: "Non, mais je peux prêter mon nom" };
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollClosedAt: new Date("2026-10-05T07:00:00Z") }));
    vi.mocked(findLastSuccessfulEventDetail).mockResolvedValue({ pollRequestId: "poll-1", ...VOTES, unresolvedVoters: [voter] });

    const result = await createCollectVotesNode(deps)(state());

    expect(findLastSuccessfulEventDetail).toHaveBeenCalledWith(deps.db, "job-1", "collect_votes");
    expect(resolveVotes).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ ...VOTES, unresolvedVoters: [voter] });
  });

  it("relance avec poll_closed_at sans événement : échec explicite", async () => {
    vi.mocked(getJobRunById).mockResolvedValue(job({ pollClosedAt: new Date() }));

    await expect(createCollectVotesNode(deps)(state())).rejects.toThrow("sondage fermé, votes introuvables");
    expect(resolveVotes).not.toHaveBeenCalled();
  });

  it("job antérieur à POLL_CLOSURE_SINCE : pas de suppression, désépinglage seul", async () => {
    vi.mocked(getJobRunById).mockResolvedValue(job({ createdAt: new Date(POLL_CLOSURE_SINCE.getTime() - 1) }));

    await createCollectVotesNode(deps)(state(true));

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
    expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "poll-msg-1", "du sondage");
  });

  it("mode test (annonce ≠ sondage) : pas de suppression, désépinglage seul, récap sur le groupe test", async () => {
    vi.mocked(resolveAnnounceNotifyJid).mockResolvedValue("test@g.us");

    await createCollectVotesNode(deps)(state(true));

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(setJobRunPollClosedAt).not.toHaveBeenCalled();
    expect(unpinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "poll-msg-1", "du sondage");
    expect(sendMessage).toHaveBeenCalledWith(deps.huddleBot.client, "test@g.us", expect.stringContaining("🔒 Inscriptions closes"));
  });
});

describe("createCollectVotesNode — messages (spec 2026-10-09 §2, §3)", () => {
  it("récap envoyé au groupe de l'annonce, épinglé et mémorisé si la règle l'active", async () => {
    await createCollectVotesNode(deps)(state(true));

    expect(sendMessage).toHaveBeenCalledWith(
      deps.huddleBot.client,
      "group@test",
      "🔒 Inscriptions closes — samedi 10 octobre 🎾\n⏰ 10h30 (2) : Hugo MERCIER, Vincent LACOSTE\nLes courts arrivent bientôt 😉",
    );
    expect(pinBestEffort).toHaveBeenCalledWith(deps, "Samedi", "group@test", "recap-1", "du récap");
    expect(setJobRunRecapInfo).toHaveBeenCalledWith(deps.db, "job-1", { msgId: "recap-1", jid: "group@test" });
  });

  it("épinglage désactivé : récap envoyé, ni épinglé ni mémorisé", async () => {
    await createCollectVotesNode(deps)(state(false));

    expect(sendMessage).toHaveBeenCalled();
    expect(pinBestEffort).not.toHaveBeenCalled();
    expect(setJobRunRecapInfo).not.toHaveBeenCalled();
  });

  it("Telegram : « Confirmés par heure » puis non-identifiés, avant le récap", async () => {
    const voter = { name: "Vince", phone: "+33663892186", option: "Non, mais je peux prêter mon nom" };
    vi.mocked(resolveVotes).mockResolvedValue({ ...VOTES, unresolvedVoters: [voter] });

    await createCollectVotesNode(deps)(state());

    expect(telegramTexts()[0]).toBe("[Samedi] Confirmés par heure — 10H30 : 2.");
    expect(telegramTexts()[1]).toContain("[Samedi] ⚠️ 1 votant(s) non identifié(s)");
    expect(vi.mocked(sendTelegramMessage).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(sendMessage).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(sendMessage).mock.calls[0]![2]).toContain("🙏 Merci à Vince pour le prête-nom :)");
  });

  it("récap en échec : signalé sur Telegram", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new Error("whatsapp down"));

    await createCollectVotesNode(deps)(state());

    expect(telegramTexts()).toContain("[Samedi] Récap des inscrits non envoyé : whatsapp down");
  });
});
```

- [ ] **Étape 2 : Lancer les tests (échec attendu)**

Run : `npm run worker:test -- collectVotes.test.ts`
Résultat attendu : FAIL. `POLL_CLOSURE_SINCE` est undefined, `deleteMessage` n'est jamais appelé, et aucun récap n'est envoyé.

- [ ] **Étape 3 : Implémenter**

Remplacer tout le contenu de `collectVotes.ts` par :

```ts
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import { getJobRunById, setJobRunPollClosedAt, setJobRunRecapInfo } from "../../jobRuns.js";
import { deleteMessage, sendMessage } from "../../mcp/huddleBot.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { findLastSuccessfulEventDetail, withEventLogging } from "../emitEvent.js";
import { pinBestEffort, unpinBestEffort } from "../pinning.js";
import { resolveVotes, type ResolvedVotes } from "../resolveVotes.js";
import { buildUnresolvedVotersMessage } from "../unresolvedVoters.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";
import { fetchMemberNames, resolveAnnounceNotifyJid } from "./announce.js";
import { buildRegistrationRecapMessage } from "./registrationRecap.js";

/**
 * Mise en production de la clôture (spec 2026-10-09, ADR-037) : seuls les jobs créés depuis ont un
 * sondage qui annonce l'heure de clôture, et seuls eux sont supprimés à la collecte. Ne jamais la
 * fixer avant l'instant du déploiement.
 */
export const POLL_CLOSURE_SINCE = new Date("2026-10-10T00:00:00Z");

interface CollectContext {
  deps: GraphDependencies;
  bookingRule: BookingRule;
  ruleLabel: string;
  jobRunId: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Telegram non bloquant : un échec ici ne doit jamais faire rejouer le nœud. */
async function notify(deps: GraphDependencies, text: string): Promise<void> {
  await sendTelegramMessage(deps.telegram, text).catch((err) => {
    console.error("[collectVotes] Telegram non envoyé :", err);
  });
}

export function createCollectVotesNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate, pollRequestId } = state;
    const ctx: CollectContext = { deps, bookingRule, ruleLabel: bookingRule.name ?? bookingRule.id, jobRunId };
    const job = await getJobRunById(deps.db, bookingRule.id, jobRunId);

    // Sondage déjà supprimé (relance après un arrêt en cours d'étape) : get_responses renverrait
    // « aucune_reponse » pour tout le monde, sans erreur. On ne relit jamais un sondage fermé.
    if (job?.pollClosedAt) return toStateUpdate(await votesFromLastCollect(deps, jobRunId));

    const votes = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "collect_votes", targetDate },
      async () => {
        if (!pollRequestId) {
          throw new Error(`pollRequestId manquant — SendPoll n'a pas été exécuté.`);
        }
        const result = await resolveVotes(deps, pollRequestId, bookingRule.candidateStartTimes);
        return { result, detail: { pollRequestId, ...result } };
      },
    );

    const announceJid = await resolveAnnounceNotifyJid(deps, bookingRule);
    await closePoll(ctx, job, announceJid);
    await sendTelegramSummaries(ctx, votes);
    await sendRegistrationRecap(ctx, targetDate, votes, announceJid);
    return toStateUpdate(votes);
  };
}

function toStateUpdate(votes: ResolvedVotes): Partial<PipelineStateType> {
  return {
    confirmedPlayerIdsByTime: votes.confirmedPlayerIdsByTime,
    volunteerSubstituteIds: votes.volunteerSubstituteIds,
    unresolvedVoters: votes.unresolvedVoters,
  };
}

async function votesFromLastCollect(deps: GraphDependencies, jobRunId: string): Promise<ResolvedVotes> {
  const detail = (await findLastSuccessfulEventDetail(deps.db, jobRunId, "collect_votes")) as Partial<ResolvedVotes> | undefined;
  if (!detail?.confirmedPlayerIdsByTime) {
    // Le scheduler relaie l'erreur sur Telegram (Erreur CollectVotes / Erreur (relance)).
    throw new Error("sondage fermé, votes introuvables (aucune collecte réussie enregistrée pour ce job).");
  }
  return {
    confirmedPlayerIdsByTime: detail.confirmedPlayerIdsByTime,
    volunteerSubstituteIds: detail.volunteerSubstituteIds ?? [],
    unresolvedVoters: detail.unresolvedVoters ?? [],
  };
}

/**
 * Suppression du sondage (WhatsApp n'a pas de fermeture native) — seulement si l'annonce part sur le
 * groupe du sondage (sinon mode test : désépinglage seul) et pour un job postérieur à
 * POLL_CLOSURE_SINCE. Un sondage supprimé perd son épinglage avec lui.
 */
async function closePoll(ctx: CollectContext, job: JobRun | undefined, announceJid: string): Promise<void> {
  const { deps, bookingRule, ruleLabel, jobRunId } = ctx;
  const pollMsgId = job?.pollMsgId ?? null;
  const deletable =
    announceJid === bookingRule.whatsappGroupJid && job !== undefined && job.createdAt >= POLL_CLOSURE_SINCE;
  if (!deletable || !pollMsgId) {
    await unpinPoll(ctx, pollMsgId);
    return;
  }
  try {
    await deleteMessage(deps.huddleBot.client, bookingRule.whatsappGroupJid, pollMsgId);
  } catch (err) {
    await notify(deps, `[${ruleLabel}] Suppression du sondage échouée : ${errorText(err)}`);
    await unpinPoll(ctx, pollMsgId);
    return;
  }
  try {
    await setJobRunPollClosedAt(deps.db, jobRunId);
  } catch (err) {
    await notify(
      deps,
      `[${ruleLabel}] Sondage supprimé mais clôture non enregistrée (poll_closed_at) : ${errorText(err)} — ne pas relancer la collecte, les votes ne seraient plus lisibles.`,
    );
  }
}

async function unpinPoll(ctx: CollectContext, pollMsgId: string | null): Promise<void> {
  if (!ctx.bookingRule.pinMessagesEnabled || !pollMsgId) return;
  await unpinBestEffort(ctx.deps, ctx.ruleLabel, ctx.bookingRule.whatsappGroupJid, pollMsgId, "du sondage");
}

async function sendTelegramSummaries(ctx: CollectContext, votes: ResolvedVotes): Promise<void> {
  const { deps, bookingRule, ruleLabel } = ctx;
  const perTime = bookingRule.candidateStartTimes
    .map((time) => `${time} : ${votes.confirmedPlayerIdsByTime[time]?.length ?? 0}`)
    .join(", ");
  const volunteerSuffix =
    votes.volunteerSubstituteIds.length > 0 ? `, ${votes.volunteerSubstituteIds.length} prête-nom(s) volontaire(s)` : "";
  await notify(deps, `[${ruleLabel}] Confirmés par heure — ${perTime}${volunteerSuffix}.`);
  if (votes.unresolvedVoters.length > 0) {
    await notify(deps, buildUnresolvedVotersMessage(ruleLabel, votes.unresolvedVoters));
  }
}

/** Récap WhatsApp des inscrits sur le groupe de l'annonce (dry-run compris), épinglé si la règle l'active. */
async function sendRegistrationRecap(
  ctx: CollectContext,
  targetDate: string,
  votes: ResolvedVotes,
  announceJid: string,
): Promise<void> {
  const { deps, bookingRule, ruleLabel, jobRunId } = ctx;
  try {
    const memberNames = await fetchMemberNames(deps.resaSquash, bookingRule.resaSquashGroupId).catch(
      () => ({}) as Record<string, string>,
    );
    const text = buildRegistrationRecapMessage({
      targetDate,
      candidateStartTimes: bookingRule.candidateStartTimes,
      ...votes,
      memberNames,
    });
    const { msgId } = await sendMessage(deps.huddleBot.client, announceJid, text);
    if (bookingRule.pinMessagesEnabled && msgId) {
      await pinBestEffort(deps, ruleLabel, announceJid, msgId, "du récap");
      await setJobRunRecapInfo(deps.db, jobRunId, { msgId, jid: announceJid });
    }
  } catch (err) {
    await notify(deps, `[${ruleLabel}] Récap des inscrits non envoyé : ${errorText(err)}`);
  }
}
```

- [ ] **Étape 4 : Relancer les tests (PASS attendu)**

Run : `npm run worker:test -- collectVotes.test.ts && npm run worker:typecheck && npm run worker:test`
Résultat attendu : PASS.

- [ ] **Étape 5 : Commit**

```bash
git add apps/worker/src/graph/nodes/collectVotes.ts apps/worker/src/graph/nodes/collectVotes.test.ts
git commit -m "feat(collecte): suppression du sondage après lecture et récap des inscrits épinglé

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tâche 10 : Désépinglage du récap (tick, sondage suivant, annulations) et refus d'annuler un sondage clôturé

**Fichiers :**
- Create : `apps/worker/src/scheduler/recapUnpin.ts`
- Modify : `apps/worker/src/scheduler/scheduler.ts` (imports l.19-35, `scheduleBookingRules` l.158-175, nouvelle fonction `triggerRecapUnpins` après `triggerStartReminders`)
- Modify : `apps/worker/src/graph/pinning.ts`
- Modify : `apps/worker/src/graph/nodes/sendPoll.ts:4`, `:16`, `:75-87`
- Modify : `apps/worker/src/closures/cancelJobForClosure.ts:41-61`
- Modify : `apps/worker/src/http/server.ts:458-484` (`handleCancelPoll` exporté)
- Test : `apps/worker/src/scheduler/recapUnpin.test.ts` (nouveau), `apps/worker/src/scheduler/scheduler.test.ts`, `apps/worker/src/graph/pinning.test.ts`, `apps/worker/src/graph/nodes/sendPoll.test.ts`, `apps/worker/src/closures/cancelJobForClosure.test.ts`, `apps/worker/src/http/server.test.ts` (nouveau)

**Interfaces :**
- Consomme : `listJobRunsWithPinnedRecap`, `setJobRunRecapInfo` et `findPreviousPinnedRecap` (tâche 7) ; `unpinMessage(client, jid, msgId)` (huddleBot.ts) ; `parisMinutesNow(now: Date): number` et `firstReservedSlotMinutes(groups, failures): number | null` (startReminder.ts) ; `computeTargetDate(now, 0)` (weekKey.ts).
- Produit :
  - `export const RECAP_UNPIN_FALLBACK_MINUTES = 23 * 60 + 59` ;
  - `export function isRecapUnpinDue(input: { targetDate: string; firstReservedSlotMinutes: number | null; cancelled: boolean; now: Date }): boolean` (recapUnpin.ts) ;
  - `export async function triggerRecapUnpins(now: Date, graph: PipelineGraph, telegram: TelegramConfig, db: Database, huddleBot: McpConnection): Promise<void>` et `export function __resetRecapUnpinLogForTests(): void` (scheduler.ts) ;
  - `export async function unpinRecapNow(deps: GraphDependencies, ruleLabel: string, job: Pick<JobRun, "id" | "recapMsgId" | "recapJid">): Promise<void>` (pinning.ts, ne lève jamais) ;
  - `export async function handleCancelPoll(res: ServerResponse, deps: HttpServerDeps, ruleId: string, jobId: string): Promise<void>` (server.ts).

- [ ] **Étape 1 : Écrire les tests qui échouent**

Créer `apps/worker/src/scheduler/recapUnpin.test.ts` :

```ts
import { describe, expect, it } from "vitest";
import { isRecapUnpinDue } from "./recapUnpin.js";

// samedi 10 octobre 2026, Paris = UTC+2
const atParis = (minutes: number) => new Date(Date.UTC(2026, 9, 9, 22, 0) + minutes * 60_000);
const due = (targetDate: string, firstSlot: number | null, now: Date, cancelled = false) =>
  isRecapUnpinDue({ targetDate, firstReservedSlotMinutes: firstSlot, cancelled, now });

describe("isRecapUnpinDue (spec 2026-10-09 §2.3)", () => {
  it("jour du match : dû à l'heure du premier créneau réservé, pas avant", () => {
    expect(due("2026-10-10", 10 * 60 + 30, atParis(10 * 60 + 29))).toBe(false);
    expect(due("2026-10-10", 10 * 60 + 30, atParis(10 * 60 + 30))).toBe(true);
  });

  it("aucun créneau réservé : 23h59", () => {
    expect(due("2026-10-10", null, atParis(23 * 60 + 58))).toBe(false);
    expect(due("2026-10-10", null, atParis(23 * 60 + 59))).toBe(true);
  });

  it("rattrapage : date du match passée", () => {
    expect(due("2026-10-09", 10 * 60 + 30, atParis(0))).toBe(true);
  });

  it("match à venir : pas dû, sauf job annulé (désépinglage immédiat à retenter)", () => {
    expect(due("2026-10-15", null, atParis(12 * 60))).toBe(false);
    expect(due("2026-10-15", null, atParis(12 * 60), true)).toBe(true);
  });
});
```

Dans `scheduler.test.ts` :
- dans le mock `../jobRuns.js`, ajouter `listJobRunsWithPinnedRecap: vi.fn(async () => []),` et `setJobRunRecapInfo: vi.fn(async () => {}),` ;
- remplacer le mock `../mcp/huddleBot.js` par `vi.mock("../mcp/huddleBot.js", () => ({ sendMessage: vi.fn(async () => {}), unpinMessage: vi.fn(async () => {}) }));` ;
- compléter les imports : `listJobRunsWithPinnedRecap, setJobRunRecapInfo` depuis `../jobRuns.js`, `unpinMessage` depuis `../mcp/huddleBot.js`, `__resetRecapUnpinLogForTests, triggerRecapUnpins` depuis `./scheduler.js` ;
- ajouter en fin de fichier :

```ts
describe("triggerRecapUnpins (spec 2026-10-09 §2.3)", () => {
  const huddleBot = { client: {} as never, close: async () => {} };
  const telegram = { botToken: "t", chatId: "c" };
  const db = {} as never;
  // samedi 10 octobre 2026, Paris = UTC+2
  const atParis = (minutes: number) => new Date(Date.UTC(2026, 9, 9, 22, 0) + minutes * 60_000);
  const recapJob = (overrides: Partial<JobRun> = {}) =>
    job({ id: "job-recap", targetDate: "2026-10-10", recapMsgId: "recap-1", recapJid: "group@test", ...overrides });
  const announcedGraph = () =>
    ({
      getState: vi.fn().mockResolvedValue({
        next: [],
        values: {
          pollRequestId: "p",
          goConfirmed: true,
          bookingPlanGroups: [
            {
              startTime: "10H30",
              outOfWindowSessionIds: [],
              plan: {
                proposedBookings: [{ sessionId: "s1", court: 4, userId: "a", partnerId: "b", slotTime: "10H30", slotEndTime: "11H15" }],
                warnings: [],
                meta: {} as never,
              },
            },
          ],
        },
      }),
    }) as unknown as PipelineGraph;

  beforeEach(() => {
    __resetRecapUnpinLogForTests();
    vi.mocked(unpinMessage).mockReset().mockResolvedValue(undefined);
    vi.mocked(setJobRunRecapInfo).mockClear();
    vi.mocked(sendTelegramMessage).mockClear();
    vi.mocked(loadBookingRules).mockResolvedValue([rule({ enabled: false, startReminderEnabled: false })]);
  });

  it("jour du match, à l'heure du premier créneau : désépingle et oublie (règle et rappel désactivés)", async () => {
    vi.mocked(listJobRunsWithPinnedRecap).mockResolvedValue([recapJob()]);

    await triggerRecapUnpins(atParis(10 * 60 + 30), announcedGraph(), telegram, db, huddleBot);

    expect(listJobRunsWithPinnedRecap).toHaveBeenCalledWith(db, "2026-10-10");
    expect(unpinMessage).toHaveBeenCalledWith(huddleBot.client, "group@test", "recap-1");
    expect(setJobRunRecapInfo).toHaveBeenCalledWith(db, "job-recap", null);
  });

  it("avant le premier créneau : rien", async () => {
    vi.mocked(listJobRunsWithPinnedRecap).mockResolvedValue([recapJob()]);

    await triggerRecapUnpins(atParis(10 * 60 + 29), announcedGraph(), telegram, db, huddleBot);

    expect(unpinMessage).not.toHaveBeenCalled();
  });

  it("job non annoncé (aucun créneau réservé) : 23h59", async () => {
    vi.mocked(listJobRunsWithPinnedRecap).mockResolvedValue([recapJob()]);
    const graph = { getState: vi.fn().mockResolvedValue({ next: [], values: { pollRequestId: "p", bookingPlanGroups: [] } }) } as unknown as PipelineGraph;

    await triggerRecapUnpins(atParis(23 * 60 + 58), graph, telegram, db, huddleBot);
    expect(unpinMessage).not.toHaveBeenCalled();
    await triggerRecapUnpins(atParis(23 * 60 + 59), graph, telegram, db, huddleBot);
    expect(unpinMessage).toHaveBeenCalledTimes(1);
  });

  it("rattrapage : match passé, état LangGraph non lu", async () => {
    vi.mocked(listJobRunsWithPinnedRecap).mockResolvedValue([recapJob({ targetDate: "2026-10-03" })]);
    const graph = { getState: vi.fn() } as unknown as PipelineGraph;

    await triggerRecapUnpins(atParis(8 * 60), graph, telegram, db, huddleBot);

    expect(unpinMessage).toHaveBeenCalledWith(huddleBot.client, "group@test", "recap-1");
    expect(graph.getState).not.toHaveBeenCalled();
  });

  it("job annulé, match dans 5 jours : désépinglé tout de suite", async () => {
    vi.mocked(listJobRunsWithPinnedRecap).mockResolvedValue([recapJob({ targetDate: "2026-10-15", cancelledAt: new Date() })]);

    await triggerRecapUnpins(atParis(12 * 60), announcedGraph(), telegram, db, huddleBot);

    expect(unpinMessage).toHaveBeenCalled();
  });

  it("désépinglage en échec : recap_msg_id conservé, un seul Telegram sur deux ticks", async () => {
    vi.mocked(listJobRunsWithPinnedRecap).mockResolvedValue([recapJob({ targetDate: "2026-10-03" })]);
    vi.mocked(unpinMessage).mockRejectedValue(new Error("huddle down"));

    await triggerRecapUnpins(atParis(8 * 60), announcedGraph(), telegram, db, huddleBot);
    await triggerRecapUnpins(atParis(8 * 60 + 1), announcedGraph(), telegram, db, huddleBot);

    expect(setJobRunRecapInfo).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessage).toHaveBeenCalledWith(telegram, expect.stringContaining("Désépinglage du récap échoué : huddle down"));
  });
});
```

Dans `pinning.test.ts`, ajouter après les mocks existants `vi.mock("../jobRuns.js", () => ({ setJobRunRecapInfo: vi.fn(async () => {}) }));`, ajouter `unpinRecapNow` à la déstructuration de `./pinning.js` et `const { setJobRunRecapInfo } = await import("../jobRuns.js");`. Ajouter `db: {} as never,` dans `deps`, puis :

```ts
describe("unpinRecapNow (spec 2026-10-09 §2.3)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sans récap épinglé : rien", async () => {
    await unpinRecapNow(deps, "Samedi", { id: "job-1", recapMsgId: null, recapJid: null });
    expect(unpinMessage).not.toHaveBeenCalled();
  });

  it("désépingle puis oublie le récap", async () => {
    await unpinRecapNow(deps, "Samedi", { id: "job-1", recapMsgId: "recap-1", recapJid: "g@test" });
    expect(unpinMessage).toHaveBeenCalledWith(expect.anything(), "g@test", "recap-1");
    expect(setJobRunRecapInfo).toHaveBeenCalledWith(deps.db, "job-1", null);
  });

  it("désépinglage en échec : récap conservé, aucune exception", async () => {
    vi.mocked(unpinMessage).mockRejectedValueOnce(new Error("boom"));
    await expect(unpinRecapNow(deps, "Samedi", { id: "job-1", recapMsgId: "recap-1", recapJid: "g@test" })).resolves.toBeUndefined();
    expect(setJobRunRecapInfo).not.toHaveBeenCalled();
  });
});
```

Dans `sendPoll.test.ts`, compléter le mock `../../jobRuns.js` avec `findPreviousPinnedRecap: vi.fn(async () => undefined),` et `setJobRunRecapInfo: vi.fn(async () => {}),`, les récupérer dans l'import dynamique, puis ajouter dans `describe("épinglage")` :

```ts
    it("désépingle le récap précédent resté épinglé, indépendamment de la case, puis l'oublie", async () => {
      vi.mocked(findPreviousPinnedRecap).mockResolvedValueOnce({ jobId: "job-0", msgId: "recap-0", jid: "notify@test" });

      await createSendPollNode(deps([]))(state());

      expect(findPreviousPinnedRecap).toHaveBeenCalledWith(expect.anything(), "test-rule", "job-1");
      expect(unpinBestEffort).toHaveBeenCalledWith(expect.anything(), "test-rule", "notify@test", "recap-0", "du récap précédent");
      expect(setJobRunRecapInfo).toHaveBeenCalledWith(expect.anything(), "job-0", null);
    });
```

Dans `cancelJobForClosure.test.ts`, ajouter `vi.mock("../graph/pinning.js", () => ({ unpinRecapNow: vi.fn(async () => {}) }));` et `const { unpinRecapNow } = await import("../graph/pinning.js");`, puis :

```ts
  it("sondage déjà supprimé à la collecte : pas de delete_message, « J'ai supprimé le sondage », récap désépinglé", async () => {
    const closedJob = job({ pollClosedAt: new Date("2026-09-14T07:00:00Z"), recapMsgId: "recap-1", recapJid: "g@test" });

    const result = await cancelJobForClosure(deps, rule, closedJob, entry, closure);

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(deps.huddleBot.client, "g@test", EXPECTED_MSG_DELETED);
    expect(vi.mocked(sendMessage).mock.calls[0]![2]).not.toContain("Ignorez le sondage");
    expect(unpinRecapNow).toHaveBeenCalledWith(deps, "Samedi", closedJob);
    expect(result).toEqual({ ok: true, jobId: "job-1", pollDeleted: true });
  });
```

Créer `apps/worker/src/http/server.test.ts` :

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";

vi.mock("../bookingRules.js", () => ({ getBookingRuleById: vi.fn() }));
vi.mock("../jobRuns.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jobRuns.js")>()),
  getJobRunById: vi.fn(),
  cancelJobRun: vi.fn(async () => ({})),
}));
vi.mock("../mcp/huddleBot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp/huddleBot.js")>()),
  deleteMessage: vi.fn(async () => {}),
}));
vi.mock("../graph/pinning.js", () => ({ unpinRecapNow: vi.fn(async () => {}) }));

const { getBookingRuleById } = await import("../bookingRules.js");
const { getJobRunById, cancelJobRun } = await import("../jobRuns.js");
const { deleteMessage } = await import("../mcp/huddleBot.js");
const { unpinRecapNow } = await import("../graph/pinning.js");
const { handleCancelPoll } = await import("./server.js");

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, writeHead: vi.fn(), end: vi.fn() };
  res.writeHead.mockImplementation((code: number) => { res.statusCode = code; });
  res.end.mockImplementation((raw: string) => { res.body = JSON.parse(raw); });
  return res as unknown as ServerResponse & { statusCode: number; body: unknown };
}

const deps = {
  db: {} as never,
  graph: {} as never,
  telegram: { botToken: "t", chatId: "c" },
  huddleBot: { client: {} as never, close: async () => {} },
  resaSquash: { client: {} as never, close: async () => {} },
};

describe("handleCancelPoll (spec 2026-10-09 §1.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBookingRuleById).mockResolvedValue({ id: "rule-sam", name: "Samedi", whatsappGroupJid: "g@test" } as never);
  });

  it("refusé (409) si le sondage a été clôturé à la collecte", async () => {
    vi.mocked(getJobRunById).mockResolvedValue({ id: "job-1", pollMsgId: "msg-1", pollClosedAt: new Date() } as never);
    const res = fakeRes();

    await handleCancelPoll(res, deps, "rule-sam", "job-1");

    expect(res.statusCode).toBe(409);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(cancelJobRun).not.toHaveBeenCalled();
  });

  it("sondage non clôturé (mode test) : suppression, annulation, récap désépinglé", async () => {
    const job = { id: "job-1", pollMsgId: "msg-1", pollClosedAt: null, recapMsgId: "recap-1", recapJid: "test@g.us" };
    vi.mocked(getJobRunById).mockResolvedValue(job as never);
    const res = fakeRes();

    await handleCancelPoll(res, deps, "rule-sam", "job-1");

    expect(res.statusCode).toBe(200);
    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, "g@test", "msg-1");
    expect(cancelJobRun).toHaveBeenCalledWith(deps.db, "job-1");
    expect(unpinRecapNow).toHaveBeenCalledWith(deps, "Samedi", job);
  });
});
```

- [ ] **Étape 2 : Lancer les tests (échec attendu)**

Run : `npm run worker:test -- recapUnpin.test.ts scheduler.test.ts pinning.test.ts sendPoll.test.ts cancelJobForClosure.test.ts server.test.ts`
Résultat attendu : FAIL. Les modules `./recapUnpin.js` et `triggerRecapUnpins` n'existent pas, `handleCancelPoll` n'est pas exporté, et `delete_message` est rappelé après clôture.

- [ ] **Étape 3 : Implémenter**

Créer `apps/worker/src/scheduler/recapUnpin.ts` :

```ts
import { parisMinutesNow } from "./startReminder.js";
import { computeTargetDate } from "./weekKey.js";

/** Pas de créneau réservé : le récap reste épinglé jusqu'à 23h59 le jour du match (spec 2026-10-09 §2.3). */
export const RECAP_UNPIN_FALLBACK_MINUTES = 23 * 60 + 59;

/**
 * Le récap des inscrits doit-il être désépinglé maintenant ? Jour du match à l'heure du premier
 * créneau réservé (heure murale de Paris), 23h59 sans créneau, date passée (rattrapage pod arrêté),
 * ou job annulé (désépinglage immédiat à retenter).
 */
export function isRecapUnpinDue(input: {
  targetDate: string;
  firstReservedSlotMinutes: number | null;
  cancelled: boolean;
  now: Date;
}): boolean {
  if (input.cancelled) return true;
  const today = computeTargetDate(input.now, 0);
  if (input.targetDate < today) return true;
  if (input.targetDate > today) return false;
  return parisMinutesNow(input.now) >= (input.firstReservedSlotMinutes ?? RECAP_UNPIN_FALLBACK_MINUTES);
}
```

`scheduler.ts` :
- compléter l'import de `../jobRuns.js` avec `listJobRunsWithPinnedRecap, setJobRunRecapInfo,` ; remplacer `import { sendMessage } from "../mcp/huddleBot.js";` par `import { sendMessage, unpinMessage } from "../mcp/huddleBot.js";` ; compléter l'import de `./startReminder.js` en `import { START_REMINDER_REASONS, evaluateStartReminder, firstReservedSlotMinutes } from "./startReminder.js";` ; ajouter `import { isRecapUnpinDue } from "./recapUnpin.js";` ;
- dans `scheduleBookingRules`, remplacer la ligne `onStartReminderTick: …` par `onStartReminderTick: (now) => runMinuteTick(now, graph, telegram, db, huddleBot, resaSquash),` ;
- après la fonction `sendStartReminderIfDue`, ajouter :

```ts
/** Tick global à la minute (ADR-036) : rappel avant match puis désépinglage du récap, indépendants. */
async function runMinuteTick(
  now: Date,
  graph: PipelineGraph,
  telegram: TelegramConfig,
  db: Database,
  huddleBot: McpConnection,
  resaSquash: McpConnection,
): Promise<void> {
  await triggerStartReminders(now, graph, telegram, db, huddleBot, resaSquash).catch((err) => {
    console.error("[scheduler] tick rappel avant match échec :", err);
  });
  await triggerRecapUnpins(now, graph, telegram, db, huddleBot).catch((err) => {
    console.error("[scheduler] tick désépinglage du récap échec :", err);
  });
}

/** Jobs dont l'échec de désépinglage du récap a déjà été signalé — un seul Telegram par job (perdu au redémarrage). */
const recapUnpinLoggedJobIds = new Set<string>();

export function __resetRecapUnpinLogForTests(): void {
  recapUnpinLoggedJobIds.clear();
}

/**
 * Désépinglage du récap des inscrits (spec 2026-10-09 §2.3), à chaque tick : requête dédiée sur
 * `recap_msg_id`, sans filtre sur la règle (désactivée, rappel désactivé) ni sur l'annulation.
 * `recap_msg_id` n'est oublié que si le désépinglage a réussi.
 */
export async function triggerRecapUnpins(
  now: Date,
  graph: PipelineGraph,
  telegram: TelegramConfig,
  db: Database,
  huddleBot: McpConnection,
): Promise<void> {
  const today = computeTargetDate(now, 0);
  const jobs = await listJobRunsWithPinnedRecap(db, today);
  if (jobs.length === 0) return;
  const labels = new Map((await loadBookingRules(db)).map((r) => [r.id, r.name ?? r.id]));
  for (const job of jobs) {
    try {
      await unpinRecapIfDue(job, labels.get(job.bookingRuleId) ?? job.bookingRuleId, today, now, graph, telegram, db, huddleBot);
    } catch (err) {
      console.error(`[scheduler] désépinglage du récap « ${job.id} » échec :`, err);
    }
  }
}

async function unpinRecapIfDue(
  job: JobRun,
  ruleLabel: string,
  today: string,
  now: Date,
  graph: PipelineGraph,
  telegram: TelegramConfig,
  db: Database,
  huddleBot: McpConnection,
): Promise<void> {
  // L'état LangGraph n'est lu que le jour du match (seul cas où l'heure du premier créneau compte).
  const firstSlot = job.targetDate === today && !job.cancelledAt ? await firstReservedSlotOfJob(job, graph) : null;
  if (!isRecapUnpinDue({ targetDate: job.targetDate, firstReservedSlotMinutes: firstSlot, cancelled: Boolean(job.cancelledAt), now })) {
    return;
  }
  try {
    await unpinMessage(huddleBot.client, job.recapJid!, job.recapMsgId!);
  } catch (err) {
    if (recapUnpinLoggedJobIds.has(job.id)) return;
    recapUnpinLoggedJobIds.add(job.id);
    await sendTelegramMessage(
      telegram,
      `[${ruleLabel}] Désépinglage du récap échoué : ${(err as Error).message} — nouvel essai chaque minute.`,
    ).catch(() => {});
    return;
  }
  await setJobRunRecapInfo(db, job.id, null);
}

/** Premier créneau réservé (minutes Paris) d'un job annoncé, null sinon. */
async function firstReservedSlotOfJob(job: JobRun, graph: PipelineGraph): Promise<number | null> {
  const snapshot = await graph.getState(jobConfig(job.bookingRuleId, job.id));
  const values = (snapshot.values ?? {}) as Partial<PipelineStateType>;
  if (computeStage(pausedOnFromSnapshot(snapshot), values) !== "finished-announced") return null;
  return firstReservedSlotMinutes(values.bookingPlanGroups ?? [], values.reservationFailures ?? []);
}
```

`pinning.ts` : ajouter `import type { JobRun } from "@squash-assistant/db/schema";` et `import { setJobRunRecapInfo } from "../jobRuns.js";`, puis en fin de fichier :

```ts
/**
 * Désépingle tout de suite le récap des inscrits d'un job (annulation : fermeture PUC, annulation
 * manuelle). Oublié seulement si le désépinglage a réussi ; sinon le tick à la minute réessaie.
 * Ne lève jamais : l'annulation doit aller au bout.
 */
export async function unpinRecapNow(
  deps: GraphDependencies,
  ruleLabel: string,
  job: Pick<JobRun, "id" | "recapMsgId" | "recapJid">,
): Promise<void> {
  if (!job.recapMsgId || !job.recapJid) return;
  const unpinned = await unpinBestEffort(deps, ruleLabel, job.recapJid, job.recapMsgId, "du récap");
  if (!unpinned) return;
  await setJobRunRecapInfo(deps.db, job.id, null).catch((err) => {
    console.error(`[pinning] récap du job ${job.id} désépinglé mais non oublié :`, err);
  });
}
```

`sendPoll.ts` : compléter l'import l.4 en `import { findPreviousPinnedAnnounce, findPreviousPinnedRecap, setJobRunAnnounceInfo, setJobRunPollInfo, setJobRunRecapInfo } from "../../jobRuns.js";`, ajouter `await unpinPreviousRecap(deps, bookingRule.id, ruleLabel, jobRunId);` juste après l'appel à `unpinPreviousAnnounce` (l.16), puis en fin de fichier :

```ts
// Même principe que l'annonce : indépendant de pinMessagesEnabled, oublié seulement si le désépinglage a réussi.
async function unpinPreviousRecap(
  deps: GraphDependencies,
  bookingRuleId: string,
  ruleLabel: string,
  jobRunId: string,
): Promise<void> {
  const previous = await findPreviousPinnedRecap(deps.db, bookingRuleId, jobRunId);
  if (!previous) return;
  const unpinned = await unpinBestEffort(deps, ruleLabel, previous.jid, previous.msgId, "du récap précédent");
  if (unpinned) await setJobRunRecapInfo(deps.db, previous.jobId, null);
}
```

`cancelJobForClosure.ts` : ajouter `import { unpinRecapNow } from "../graph/pinning.js";`. Remplacer le bloc `let pollDeleted = false; if (job.pollMsgId) { … }` (l.43-51) par :

```ts
  let pollDeleted = false;
  if (job.pollClosedAt) {
    // Déjà supprimé à la collecte (spec 2026-10-09) : ne pas rappeler delete_message.
    pollDeleted = true;
  } else if (job.pollMsgId) {
    try {
      await deleteMessage(deps.huddleBot.client, groupJid, job.pollMsgId);
      pollDeleted = true;
    } catch {
      pollDeleted = false;
    }
  }
```

Juste après `await cancelJobRun(…);` (l.61), ajouter `await unpinRecapNow(deps, rule.name ?? rule.id, job);`.

`server.ts` : ajouter `import { unpinRecapNow } from "../graph/pinning.js";`. Exporter `handleCancelPoll` (`export async function handleCancelPoll(`). Juste après le bloc `if (!rule || !job) { … }`, ajouter :

```ts
  // Le sondage a été supprimé à la collecte (spec 2026-10-09) : il n'y a plus rien à annuler.
  if (job.pollClosedAt) {
    sendJson(res, 409, { error: "Sondage déjà clôturé à la collecte des votes (message supprimé) — annulation impossible." });
    return;
  }
```

Dans le `try`, après `await cancelJobRun(deps.db, jobId);`, ajouter `await unpinRecapNow(deps, rule.name ?? rule.id, job);`.

- [ ] **Étape 4 : Relancer les tests (PASS attendu)**

Run : `npm run worker:test && npm run worker:typecheck`
Résultat attendu : PASS.

- [ ] **Étape 5 : Commit**

```bash
git add apps/worker/src/scheduler apps/worker/src/graph/pinning.ts apps/worker/src/graph/pinning.test.ts apps/worker/src/graph/nodes/sendPoll.ts apps/worker/src/graph/nodes/sendPoll.test.ts apps/worker/src/closures/cancelJobForClosure.ts apps/worker/src/closures/cancelJobForClosure.test.ts apps/worker/src/http/server.ts apps/worker/src/http/server.test.ts
git commit -m "feat(worker): désépinglage du récap le jour du match, à l'annulation et au sondage suivant

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tâche 11 : « Recalculer le plan » — nouvelle recherche des votants non identifiés

**Fichiers :**
- Modify : `apps/worker/src/graph/unresolvedVoters.ts` (ajout)
- Modify : `apps/worker/src/scheduler/scheduler.ts` (`triggerRecomputePlan` et nouveau helper `refreshUnresolvedVoters`)
- Modify : `apps/worker/src/http/server.ts` (appel de `triggerRecomputePlan`)
- Test : `apps/worker/src/graph/unresolvedVoters.test.ts`, `apps/worker/src/scheduler/scheduler.test.ts`

**Interfaces :**
- Consomme : `lookupPlayerByPhone(client, phone): Promise<{ found: boolean; userId?: string }>` (resaSquash.ts) ; `UnresolvedVoter` ; `SUBSTITUTE_VOLUNTEER_POLL_OPTION`.
- Produit (unresolvedVoters.ts) :
  - `export interface VotesSnapshot { confirmedPlayerIdsByTime: Record<string, string[]>; volunteerSubstituteIds: string[]; unresolvedVoters: UnresolvedVoter[] }`
  - `export interface RelookupResult extends VotesSnapshot { identified: Array<{ name: string; option: string }>; stillUnknown: string[] }`
  - `export async function relookupUnresolvedVoters(resaSquash: McpConnection, votes: VotesSnapshot): Promise<RelookupResult>`
  - `export function formatRelookupSummary(ruleLabel: string, result: RelookupResult): string | null`
- Produit (scheduler.ts) : `triggerRecomputePlan(rule: BookingRule, job: JobRun, graph: PipelineGraph, telegram: TelegramConfig, db: Database, resaSquash: McpConnection): Promise<void>`.

- [ ] **Étape 1 : Écrire les tests qui échouent**

Dans `unresolvedVoters.test.ts`, ajouter en tête `vi` à l'import vitest et `vi.mock("../mcp/resaSquash.js", () => ({ lookupPlayerByPhone: vi.fn() }));`. Remplacer l'import statique de `./unresolvedVoters.js` par `const { buildUnresolvedVotersMessage, formatRelookupSummary, relookupUnresolvedVoters } = await import("./unresolvedVoters.js");` et ajouter `const { lookupPlayerByPhone } = await import("../mcp/resaSquash.js");`. Puis :

```ts
describe("relookupUnresolvedVoters (spec 2026-10-09 §3.3)", () => {
  const SUB = "Non, mais je peux prêter mon nom";
  const resaSquash = { client: {} as never, close: async () => {} };

  it("identifié → ajouté à son heure ou aux prête-noms ; inconnu ou sans téléphone → conservé", async () => {
    vi.mocked(lookupPlayerByPhone).mockImplementation(async (_c, phone) =>
      phone === "+33663892186" ? { found: true, userId: "u-vince" } : phone === "+33600000009" ? { found: true, userId: "u-henry" } : { found: false },
    );
    const thomas = { name: "Thomas LECCIA", phone: "+33686870364", option: SUB };
    const noPhone = { name: "Sans Tel", phone: null, option: "10H30" };

    const result = await relookupUnresolvedVoters(resaSquash, {
      confirmedPlayerIdsByTime: { "10H30": ["u1"] },
      volunteerSubstituteIds: [],
      unresolvedVoters: [{ name: "Vince", phone: "+33663892186", option: SUB }, thomas, { name: "Henry", phone: "+33600000009", option: "10H30" }, noPhone],
    });

    expect(result.confirmedPlayerIdsByTime).toEqual({ "10H30": ["u1", "u-henry"] });
    expect(result.volunteerSubstituteIds).toEqual(["u-vince"]);
    expect(result.unresolvedVoters).toEqual([thomas, noPhone]);
    expect(lookupPlayerByPhone).toHaveBeenCalledTimes(3);
    expect(formatRelookupSummary("Samedi", result)).toBe(
      "[Samedi] Recalcul : Vince identifié (prête-nom), Henry identifié (10H30), Thomas LECCIA toujours inconnu",
    );
  });

  it("lookup en erreur : votant considéré toujours inconnu", async () => {
    vi.mocked(lookupPlayerByPhone).mockRejectedValue(new Error("resa down"));
    const voter = { name: "Vince", phone: "+33663892186", option: SUB };

    const result = await relookupUnresolvedVoters(resaSquash, { confirmedPlayerIdsByTime: {}, volunteerSubstituteIds: [], unresolvedVoters: [voter] });

    expect(result.unresolvedVoters).toEqual([voter]);
    expect(result.stillUnknown).toEqual(["Vince"]);
  });

  it("rien de retenté : pas de résumé", () => {
    expect(formatRelookupSummary("Samedi", { confirmedPlayerIdsByTime: {}, volunteerSubstituteIds: [], unresolvedVoters: [], identified: [], stillUnknown: [] })).toBeNull();
  });
});
```

Dans `scheduler.test.ts` :
- remplacer le mock `../mcp/resaSquash.js` par `vi.mock("../mcp/resaSquash.js", () => ({ listGroupMembers: vi.fn(async () => ({ members: [] })), lookupPlayerByPhone: vi.fn() }));` ;
- remplacer le mock `../mcp/huddleBot.js` par `vi.mock("../mcp/huddleBot.js", () => ({ sendMessage: vi.fn(async () => {}), unpinMessage: vi.fn(async () => {}), getResponses: vi.fn() }));` ;
- importer `lookupPlayerByPhone` (avec `listGroupMembers`), `getResponses` (avec `sendMessage`, `unpinMessage`) et `triggerRecomputePlan` depuis `./scheduler.js` ;
- ajouter en fin de fichier :

```ts
describe("triggerRecomputePlan — votants non identifiés (spec 2026-10-09 §3.3)", () => {
  const telegram = { botToken: "t", chatId: "c" };
  const resaSquash = { client: {} as never, close: async () => {} };
  const SUB = "Non, mais je peux prêter mon nom";
  const config = { configurable: { thread_id: "test-rule:job-1" } };

  function awaitingGoGraph(values: Record<string, unknown>) {
    return {
      getState: vi.fn().mockResolvedValue({
        next: ["waitForGoConfirmation"],
        values: { pollRequestId: "p", bookingPlanGroups: [], confirmedPlayerIdsByTime: { "10H30": ["u1"] }, volunteerSubstituteIds: [], ...values },
      }),
      updateState: vi.fn(async () => ({})),
      invoke: vi.fn(async () => ({})),
    };
  }

  beforeEach(() => {
    vi.mocked(sendTelegramMessage).mockClear();
    vi.mocked(lookupPlayerByPhone).mockReset();
    vi.mocked(getResponses).mockClear();
  });

  it("recherche à nouveau par téléphone, met à jour l'état avant le recalcul, résumé Telegram, sans relire le sondage", async () => {
    vi.mocked(lookupPlayerByPhone).mockImplementation(async (_c, phone) =>
      phone === "+33663892186" ? { found: true, userId: "u-vince" } : phone === "+33600000009" ? { found: true, userId: "u-henry" } : { found: false },
    );
    const thomas = { name: "Thomas LECCIA", phone: "+33686870364", option: SUB };
    const graph = awaitingGoGraph({
      unresolvedVoters: [{ name: "Vince", phone: "+33663892186", option: SUB }, thomas, { name: "Henry", phone: "+33600000009", option: "10H30" }],
    });

    await triggerRecomputePlan(rule(), job(), graph as unknown as PipelineGraph, telegram, {} as never, resaSquash);

    expect(graph.updateState).toHaveBeenCalledWith(
      config,
      { confirmedPlayerIdsByTime: { "10H30": ["u1", "u-henry"] }, volunteerSubstituteIds: ["u-vince"], unresolvedVoters: [thomas] },
      "waitForPlanTrigger",
    );
    expect(vi.mocked(graph.updateState).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(graph.invoke).mock.invocationCallOrder[0]!);
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      telegram,
      "[test-rule] Recalcul : Vince identifié (prête-nom), Henry identifié (10H30), Thomas LECCIA toujours inconnu",
    );
    expect(getResponses).not.toHaveBeenCalled();
  });

  it("aucun votant non identifié : état inchangé, aucune recherche", async () => {
    const graph = awaitingGoGraph({});

    await triggerRecomputePlan(rule(), job(), graph as unknown as PipelineGraph, telegram, {} as never, resaSquash);

    expect(graph.updateState).toHaveBeenCalledWith(config, {}, "waitForPlanTrigger");
    expect(lookupPlayerByPhone).not.toHaveBeenCalled();
  });
});
```

- [ ] **Étape 2 : Lancer les tests (échec attendu)**

Run : `npm run worker:test -- unresolvedVoters.test.ts scheduler.test.ts`
Résultat attendu : FAIL. `relookupUnresolvedVoters is not a function` et `updateState` est appelé avec `{}`.

- [ ] **Étape 3 : Implémenter**

`unresolvedVoters.ts` : ajouter en tête `import type { McpConnection } from "../mcp/client.js";`, `import { lookupPlayerByPhone } from "../mcp/resaSquash.js";`, `import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "./nodes/pollQuestion.js";`, puis en fin de fichier :

```ts
export interface VotesSnapshot {
  confirmedPlayerIdsByTime: Record<string, string[]>;
  volunteerSubstituteIds: string[];
  unresolvedVoters: UnresolvedVoter[];
}

export interface RelookupResult extends VotesSnapshot {
  identified: Array<{ name: string; option: string }>;
  stillUnknown: string[];
}

async function lookupUserId(resaSquash: McpConnection, phone: string): Promise<string | null> {
  try {
    const lookup = await lookupPlayerByPhone(resaSquash.client, phone);
    return lookup.found && lookup.userId ? lookup.userId : null;
  } catch {
    return null;
  }
}

/**
 * « Recalculer le plan » (spec 2026-10-09 §3.3) : relance `lookup_player_by_phone` pour chaque
 * votant non identifié qui a un téléphone (le sondage est fermé, on ne le relit pas). Identifié →
 * ajouté à son heure ou aux prête-noms ; toujours inconnu ou sans téléphone → conservé.
 */
export async function relookupUnresolvedVoters(resaSquash: McpConnection, votes: VotesSnapshot): Promise<RelookupResult> {
  const confirmedPlayerIdsByTime = Object.fromEntries(
    Object.entries(votes.confirmedPlayerIdsByTime).map(([time, ids]) => [time, [...ids]]),
  );
  const volunteerSubstituteIds = [...votes.volunteerSubstituteIds];
  const unresolvedVoters: UnresolvedVoter[] = [];
  const identified: RelookupResult["identified"] = [];
  const stillUnknown: string[] = [];

  for (const voter of votes.unresolvedVoters) {
    if (!voter.phone) {
      unresolvedVoters.push(voter);
      continue;
    }
    const userId = await lookupUserId(resaSquash, voter.phone);
    const target =
      voter.option === SUBSTITUTE_VOLUNTEER_POLL_OPTION ? volunteerSubstituteIds : confirmedPlayerIdsByTime[voter.option];
    if (!userId || !target) {
      unresolvedVoters.push(voter);
      stillUnknown.push(voter.name);
      continue;
    }
    if (!target.includes(userId)) target.push(userId);
    identified.push({ name: voter.name, option: voter.option });
  }

  return { confirmedPlayerIdsByTime, volunteerSubstituteIds, unresolvedVoters, identified, stillUnknown };
}

/** « [règle] Recalcul : Vince identifié (prête-nom), Thomas LECCIA toujours inconnu » ; null si personne n'a été recherché. */
export function formatRelookupSummary(ruleLabel: string, result: RelookupResult): string | null {
  const parts = [
    ...result.identified.map((v) => `${v.name} identifié (${v.option === SUBSTITUTE_VOLUNTEER_POLL_OPTION ? "prête-nom" : v.option})`),
    ...result.stillUnknown.map((name) => `${name} toujours inconnu`),
  ];
  return parts.length === 0 ? null : `[${ruleLabel}] Recalcul : ${parts.join(", ")}`;
}
```

`scheduler.ts` :
- ajouter `import { formatRelookupSummary, relookupUnresolvedVoters } from "../graph/unresolvedVoters.js";` ;
- ajouter le paramètre `resaSquash: McpConnection,` en dernier à `triggerRecomputePlan` ;
- dans son `try`, remplacer `await graph.updateState(config, {}, "waitForPlanTrigger");` par :

```ts
    const update = await refreshUnresolvedVoters(rule, status, resaSquash, telegram);
    await graph.updateState(config, update, "waitForPlanTrigger");
```

- ajouter juste après `triggerRecomputePlan` :

```ts
/** Nouvelle recherche des votants non identifiés avant le recalcul (spec 2026-10-09 §3.3) — `{}` si personne n'a de téléphone. */
async function refreshUnresolvedVoters(
  rule: BookingRule,
  status: RuleExecutionStatus,
  resaSquash: McpConnection,
  telegram: TelegramConfig,
): Promise<Partial<PipelineStateType>> {
  const voters = status.values.unresolvedVoters ?? [];
  if (!voters.some((v) => v.phone)) return {};
  const result = await relookupUnresolvedVoters(resaSquash, {
    confirmedPlayerIdsByTime: status.values.confirmedPlayerIdsByTime ?? {},
    volunteerSubstituteIds: status.values.volunteerSubstituteIds ?? [],
    unresolvedVoters: voters,
  });
  const summary = formatRelookupSummary(rule.name ?? rule.id, result);
  if (summary) await sendTelegramMessage(telegram, summary).catch(() => {});
  return {
    confirmedPlayerIdsByTime: result.confirmedPlayerIdsByTime,
    volunteerSubstituteIds: result.volunteerSubstituteIds,
    unresolvedVoters: result.unresolvedVoters,
  };
}
```

`server.ts` (branche `recompute-plan`) : `await triggerRecomputePlan(rule, job, deps.graph, deps.telegram, deps.db, deps.resaSquash);`.

- [ ] **Étape 4 : Relancer les tests (PASS attendu)**

Run : `npm run worker:test && npm run typecheck`
Résultat attendu : PASS.

- [ ] **Étape 5 : Commit**

```bash
git add apps/worker/src/graph/unresolvedVoters.ts apps/worker/src/graph/unresolvedVoters.test.ts apps/worker/src/scheduler/scheduler.ts apps/worker/src/scheduler/scheduler.test.ts apps/worker/src/http/server.ts
git commit -m "feat(plan): « Recalculer le plan » recherche à nouveau les votants non identifiés par téléphone

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Tâche 12 : Documentation — règles fonctionnelles, ADR-037, vérification finale

**Fichiers :**
- Modify : `docs/spec/regles-fonctionnelles.md` (§2 l.42, §3 l.57-66, §6 l.139/l.164-168/l.189-191, §7, historique l.225)
- Create : `docs/adr/ADR-037-cloture-sondage-suppression-collecte.md`
- Modify : `docs/adr/README.md` (dernière ligne du tableau)

- [ ] **Étape 1 : `regles-fonctionnelles.md`**

- §2, remplacer la puce « Le libellé du sondage WhatsApp inclut la date cible et la liste des heures candidates (`buildPollQuestionPreview`). » par :

```markdown
- Le libellé du sondage WhatsApp inclut la date cible, la liste des heures candidates et, **depuis le 2026-10-09**, l'heure de clôture des réponses en dernier : `Squash samedi 10 octobre à 10h30 ? (réponses jusqu'au lundi 5 octobre à 9h)`. Clôture = date cible − `decisionDaysBefore` à `decisionTime` (règle **live** à l'envoi ; une modification ultérieure de la règle rend l'heure affichée fausse, accepté). Mention omise si cette heure est déjà passée à l'envoi (job manuel tardif). Même texte dans l'aperçu UI (`buildPollQuestionPreview`).
```

- §3 : remplacer la puce « Une fois à l'étape `awaiting-plan`, il reste possible de **relire les réponses** … » par :

```markdown
- **Clôture du sondage à la collecte (2026-10-09, ADR-037)** : dans l'ordre — lecture des votes (si elle échoue, rien n'est supprimé) ; puis, **si le groupe de l'annonce est le groupe du sondage** et que le job date d'après la mise en production (`POLL_CLOSURE_SINCE`), suppression du sondage WhatsApp (`delete_message`, le groupe voit « message supprimé ») et `job_runs.poll_closed_at` renseigné. Un sondage supprimé perd son épinglage ; le désépinglage n'est tenté qu'en cas d'échec de suppression (signalé sur Telegram, l'étape continue). **Mode test** (annonce ≠ sondage) : pas de suppression, désépinglage seul ; un vote tardif dans le vrai groupe reste possible et n'est pas pris en compte. Un sondage fermé n'est **jamais relu** : une relance de l'étape reprend les votes de l'événement `collect_votes` (échec explicite s'il n'existe pas). Tout ce qui suit la clôture (Telegram, récap) est non bloquant.
- **« Relire les réponses » retiré (2026-10-09)** : le sondage n'existe plus après la collecte. Une fois l'étape 2 faite, l'aperçu `pollTally` et le lien « Rafraîchir les réponses » sont masqués ; les votes collectés restent affichés. L'annulation du sondage est refusée côté worker une fois `poll_closed_at` renseigné.
- **Récap des inscrits (WhatsApp, 2026-10-09)** : envoyé à la collecte (dry-run compris) au groupe de l'annonce (règle live) : `🔒 Inscriptions closes — samedi 10 octobre 🎾`, une ligne `⏰ 10h30 (4) : noms` par heure ayant au moins un inscrit (heure au format du sondage), `🙏 Merci à X et Y pour les prête-noms :)` (« pour le prête-nom » s'il n'y en a qu'un, identifiés ou non, sans ⚠️), puis `Les courts arrivent bientôt 😉`. Sans inscrit : `🔒 Inscriptions closes — samedi 10 octobre` / `Personne cette semaine 😢`. Noms : `list_group_members` resa-squash ; un votant non identifié apparaît avec son nom WhatsApp.
- **Votants non identifiés (Telegram, 2026-10-09)** : un votant (heure ou prête-nom) dont le téléphone n'est associé à aucun compte resa-squash est exclu du plan mais listé dans le récap. Un message Telegram dédié, avant le récap, donne nom, téléphone, cause (« numéro inconnu de resa-squash » / « pas de numéro WhatsApp ») et option votée, puis invite à associer le numéro dans TeamR/resa-squash et à « Recalculer le plan » avant le go. Le « Recalculer le plan » relance `lookup_player_by_phone` pour ces votants (identifié → ajouté à son heure ou aux prête-noms ; toujours inconnu → conservé) et le signale sur Telegram ; le récap n'est pas renvoyé.
```

  - Dans la puce « Avant collecte, l'UI affiche en aperçu… », ajouter à la fin de la première phrase : « — masqué une fois les votes collectés (le sondage est alors supprimé) ».

- §6 :
  - puce « Échec total de réservation réelle » : remplacer `("⚠️ ... échec de la réservation automatique, aucun court n'a été réservé. Contactez l'organisateur.")` par `(« ⚠️ Échec de la réservation du <date> : aucun court n'a été réservé. Contactez l'organisateur. », sans nom de règle depuis le 2026-10-09)` ;
  - section épinglage : remplacer la puce **Collecte** par « **Collecte** (étape 2) : le sondage est supprimé à la collecte, ce qui retire son épinglage (désépinglage explicite seulement si la suppression échoue, ou en mode test). Le **récap des inscrits** est épinglé pour 7 jours sur le groupe de l'annonce ; `recap_msg_id` / `recap_jid` mémorisés sur le job. Il est désépinglé le jour du match à l'heure du premier créneau réservé (23h59 sans créneau), par le tick à la minute (indépendant du rappel, de la règle et de l'annulation, avec rattrapage si le pod était arrêté), tout de suite à l'annulation du job, ou au sondage suivant de la règle ; oublié seulement si le désépinglage a réussi. WhatsApp garde au plus 3 messages épinglés par groupe : une règle en utilise au plus 2 (récap + annonce). » ; dans la puce **Annonce**, remplacer `« 🏸 Réservation(s)… »` par `« 🏸 Réservation(s) confirmée(s) » / « 🏸 Réservation(s) »` ;
  - puce « Message de sursaturation » : remplacer par « **Joueurs non réservés (2026-10-09)** : la ligne *"⚠️ N joueur(s) n'ont pas pu être réservé(s) cette semaine."* compte les **joueurs confirmés sans aucun créneau réservé** (hors fenêtre et refus compris), via les groupes de court du plan (`plan.meta.courtGroups`). Un round manquant d'un groupe qui joue n'est plus compté. Ligne omise si N = 0 ou pour un plan antérieur sans `courtGroups`. » ;
  - puce « Mention d'origine automatique » : remplacer par « **Titre de l'annonce et signature (2026-10-09)** : titre sans nom de règle, accordé au nombre de créneaux fusionnés — « 🏸 Réservation confirmée » / « 🏸 Réservations confirmées » en réel, « 🏸 Réservation » / « 🏸 Réservations » en dry-run. La ligne « 🤖 Réservation effectuée automatiquement par squash-assistant. » est supprimée (la distinction avec la notification native resa-squash est abandonnée). » ;
  - puce « Synthèse votes/réservations… » : ajouter à la fin « Les volontaires non identifiés y sont listés par leur nom WhatsApp suivis de « ⚠️ non identifié » au lieu de « (aucun) » (message de debug, groupe test uniquement). »
- §4 (plan), ajouter une puce : « **Arrêt au plafond (2026-10-09)** : quand la paire du round à réserver est bloquée (plafond de résas/jour ou joueur non réinscrit) sans prête-nom ni joker pour la débloquer, la recherche des rounds restants du groupe s'arrête avec un seul warning (`X, Y : 3e round demandé mais plafond 2 résas/jour atteint — aucun prête-nom disponible et joker déjà mobilisé.`) ; un prête-nom tenté pour une paire finalement bloquée reste disponible pour les groupes suivants. »
- §7, ajouter en première puce :

```markdown
- **WhatsApp ≠ Telegram (2026-10-09)** : WhatsApp s'adresse aux joueurs — messages concis, sans détail technique, sans ⚠️ qui ne les concerne pas, avec des emojis quand ça rend la communication plus sympa (😉, 🙏, 🎾, :)). Telegram s'adresse à l'organisateur / au développeur — détails techniques bienvenus (téléphones, causes, ids). Tout nouveau message respecte cette séparation.
```

- Historique des décisions notables, ajouter en tête du tableau :

```markdown
| 2026-10-09 | Sondage annonçant sa clôture et supprimé à la collecte (jamais relu, votes repris de l'événement en cas de relance) ; récap WhatsApp des inscrits épinglé jusqu'au premier créneau ; votants non identifiés signalés sur Telegram et recherchés à nouveau au « Recalculer le plan » ; « Relire les réponses » retiré ; planificateur arrêté au plafond ; compteur de l'annonce en joueurs ; annonce allégée (ADR-037) | Job 04578758 du samedi 10/10 : votes tardifs jamais pris en compte sans que personne ne le sache, prête-noms sans compte noyés dans un message, synthèse illisible (un warning par créneau), « 1 joueur(s) n'ont pas pu être réservé(s) » alors que les 4 jouaient |
```

- [ ] **Étape 2 : ADR-037**

Créer `docs/adr/ADR-037-cloture-sondage-suppression-collecte.md` :

```markdown
# ADR-037 – Clôture du sondage par suppression du message WhatsApp à la collecte

**Status:** accepted
**Date:** 2026-10-09
**Spec:** [2026-10-09-cloture-sondage-recap-inscrits-design.md](../superpowers/specs/2026-10-09-cloture-sondage-recap-inscrits-design.md)

## Contexte

Le sondage restait votable après la collecte (étape 2). Sur le job 04578758, deux votes arrivés après la collecte n'ont jamais été pris en compte, sans que personne ne le sache. WhatsApp n'offre pas de fermeture native d'un sondage. Après `delete_message`, huddle-bot retire le sondage de son store et `get_responses` renvoie « aucune_reponse » pour tous, **sans erreur** : toute relecture après suppression produirait silencieusement un plan vide.

## Décision

1. La question du sondage annonce l'heure de clôture (date cible − `decisionDaysBefore`, à `decisionTime`, règle live à l'envoi).
2. À la collecte : lecture des votes, puis suppression du sondage (`delete_message`) et `job_runs.poll_closed_at`. Rien n'est supprimé si la lecture échoue. Un échec de suppression est signalé sur Telegram (désépinglage tenté) sans bloquer l'étape.
3. Un sondage fermé n'est jamais relu : une relance de l'étape reprend les votes du dernier événement `collect_votes` réussi, sinon échec explicite. « Relire les réponses » est retiré ; l'annulation du sondage est refusée après clôture.
4. Suppression seulement si le groupe de l'annonce est le groupe du sondage (sinon mode test : désépinglage seul) et pour les jobs créés depuis `POLL_CLOSURE_SINCE` (mise en production).
5. Un récap WhatsApp des inscrits remplace le sondage dans le groupe de l'annonce, épinglé jusqu'au premier créneau réservé du jour du match (tick à la minute d'ADR-036, requête dédiée sur `recap_msg_id`), immédiatement désépinglé à l'annulation, et nettoyé au sondage suivant.

## Alternatives écartées

- Fermeture différée (garder le sondage ouvert jusqu'au plan) : la collecte et le plan partent ensemble en auto, et un vote tardif resterait invisible.
- Relecture après suppression : impossible, `get_responses` ne distingue pas un sondage supprimé d'un sondage sans réponse.
- Message « sondage clos » en réponse au sondage sans le supprimer : le sondage resterait votable.

## Conséquences

- Migration `0033` : `job_runs.poll_closed_at`, `job_runs.recap_msg_id`, `job_runs.recap_jid`. Appliquée par l'initContainer ([ADR-012](./ADR-012-migrations-automatiques-initcontainer.md)).
- Le groupe voit « message supprimé » à la place du sondage.
- En mode test, un vote tardif reste possible dans le vrai groupe et n'est pas pris en compte ; la fermeture effective arrive quand l'annonce bascule sur le groupe du sondage.
- WhatsApp garde au plus 3 messages épinglés par groupe : une règle en utilise au plus 2 (récap + annonce) ; plusieurs règles sur un même groupe peuvent faire tomber le plus ancien sans prévenir.
- `POLL_CLOSURE_SINCE` ne doit jamais précéder l'instant du déploiement : un job créé avant n'a pas annoncé sa clôture.
```

Dans `docs/adr/README.md`, ajouter après la ligne de l'ADR 036 :

```markdown
| [037](./ADR-037-cloture-sondage-suppression-collecte.md) | Clôture du sondage par suppression du message WhatsApp à la collecte (jamais relu ensuite), récap des inscrits épinglé jusqu'au premier créneau | accepted |
```

- [ ] **Étape 3 : Vérifier `POLL_CLOSURE_SINCE` avant merge**

Comparer `POLL_CLOSURE_SINCE` (`apps/worker/src/graph/nodes/collectVotes.ts`, `2026-10-10T00:00:00Z`) à la date de déploiement prévue. Si le déploiement a lieu après, avancer la constante à l'instant du déploiement (UTC). Un job créé avant ce moment n'a pas annoncé sa clôture et ne doit pas voir son sondage supprimé.

- [ ] **Étape 4 : Vérification finale**

Run :
```bash
(cd packages/db && npm run build)
npm run typecheck
npm test
grep -rn -i "recollect" apps/worker/src apps/ui/src
graphify update .
```
Résultat attendu : typecheck et tests PASS, aucune ligne pour le grep, et `graphify update` sans erreur.

- [ ] **Étape 5 : Commit**

```bash
git add docs/spec/regles-fonctionnelles.md docs/adr/ADR-037-cloture-sondage-suppression-collecte.md docs/adr/README.md
git commit -m "docs: ADR-037 et règles fonctionnelles de la clôture du sondage et du récap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Hors périmètre

- Fermeture différée du sondage, relecture après clôture.
- Nouveau réglage de groupe pour le récap ; renvoi du récap après « Recalculer le plan ».
- Message d'annulation pour fermeture du club : il reste sur le groupe d'origine.
- Association téléphone ↔ compte : elle se fait à la main dans TeamR/resa-squash.
- Groupe de 3 : essayer la paire suivante du cycle quand la paire courante est bloquée.
- **Hors repo (resa-squash, §4.3)** : allègement de la notification native WhatsApp de resa-squash (`app/services/group-booking-digest.ts` : titre « 🏸 Réservation(s) groupe « … » », signature « Résa Squash », signature du rappel), variante Telegram conservée. C'est un chantier séparé dans le repo resa-squash.

## Auto-revue

**Couverture de la spec :**

| Section | Tâche |
|---------|-------|
| §1.1 clôture dans la question (+ aperçu UI, mention omise si passée, M = 0, puc fermé) | 6 |
| §1.2 ordre lecture → suppression → `poll_closed_at` → messages, mode test, `POLL_CLOSURE_SINCE`, relance | 9 |
| §1.2 masquage `pollTally` | 4 |
| §1.2 `cancelJobForClosure`, `handleCancelPoll` | 10 |
| §1.3 retrait de « Relire les réponses » (`pausedOnFromSnapshot` `bookSlots` conservé) | 4 |
| §1.4 épinglage du sondage | 9 (désépinglage seulement si la suppression échoue ou en mode test) |
| §2.1 contenu du récap | 8 |
| §2.2 destinataire, dry-run, mode test | 9 |
| §2.3 épinglage et désépinglage du récap (tick, rattrapage, annulation, sondage suivant) | 9, 10 |
| §3.1 message Telegram dédié, suffixe « non résolu(s) » retiré | 5, 9 |
| §3.2 `unresolvedVoters`, annotation d'état | 5 |
| §3.3 « Recalculer le plan » | 11 |
| §3.4 synthèse du groupe test | 5 |
| §4.1 arrêt au plafond, prête-noms restitués | 1 |
| §4.2 compteur de l'annonce, `meta.courtGroups` | 2 |
| §4.3 annonce allégée | 3 |
| §5 documentation, ADR-037 | 12 |
| §6 tests | répartis dans chaque tâche (voir les étapes 1) |

**Placeholders :** aucun « TBD » ni « à compléter ». Seule la valeur de `POLL_CLOSURE_SINCE` est fixée (`2026-10-10T00:00:00Z`), avec une étape de vérification explicite (tâche 12, étape 3).

**Cohérence des types entre tâches :**
- `UnresolvedVoter { name; phone: string | null; option }` est défini en tâche 5 (state.ts) et consommé dans les tâches 8, 9 et 11.
- `ResolvedVotes.unresolvedVoters` (tâche 5) est consommé en tâche 9.
- `CourtGroup` / `meta.courtGroups?` (tâche 2) est consommé par `countUnbookedConfirmedPlayers` (tâche 2), puis implicitement en tâche 3 (fixtures sans `courtGroups` → 0).
- `formatInformalDate` et `formatSessionTime` sont exportés en tâche 6 et consommés en tâche 8.
- Les helpers `jobRuns` et `findLastSuccessfulEventDetail` (tâche 7) sont consommés dans les tâches 9 à 11.
- `triggerRecomputePlan(..., resaSquash)` (tâche 11) est appelé par server.ts dans la même tâche.
- Les mocks de `scheduler.test.ts` sont complétés de manière cumulative : tâche 7 (fixtures `JobRun`), tâche 10 (`unpinMessage`, `listJobRunsWithPinnedRecap`, `setJobRunRecapInfo`), tâche 11 (`getResponses`, `lookupPlayerByPhone`).
