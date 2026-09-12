# Fermeture PUC déclarée tardivement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quand un admin ajoute une fermeture PUC dans `/settings`, montrer les jobs en cours/prévus impactés, puis, après confirmation, arrêter chaque job en cours (sondage WhatsApp supprimé, message informel au groupe, job annulé avec la cause, événement + Telegram).

**Architecture:** Le worker porte tout : un module pur de détection d'impact (`closures/closureImpact.ts`), un chargeur qui interroge DB + LangGraph (`closures/loadClosureImpact.ts`), une cascade par job (`closures/cancelJobForClosure.ts`), deux routes HTTP internes (`POST /club-closures/preview`, `POST /club-closures`) et un garde-fou dans la boucle « go » Telegram. L'UI `/settings` appelle ces routes via `callWorker` et passe en formulaire à deux temps (aperçu → confirmation). La création directe en base depuis l'UI est retirée.

**Tech Stack:** TypeScript, npm workspaces, Drizzle (Postgres), LangGraph.js, node:http, Next.js 15 (server actions, client components), vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-late-club-closure-design.md`

## Global Constraints

- Ne jamais appeler `cancel_reservation` (resa-squash) : les réservations TeamR ne sont pas touchées.
- Tous les tests worker : `npm run worker:test` ; typecheck global : `npm run typecheck`. Tests UI : `npm test -w @squash-assistant/ui`.
- Migration Drizzle générée avec `npm run db:generate -- --name <nom>` ; **ne jamais** dire à l'utilisateur de lancer `db:migrate` (initContainer, ADR-012).
- Messages WhatsApp : textes exacts de la spec (section « Messages WhatsApp »), ton informel, emoji 😕 et 💪.
- Timezone d'interprétation : Europe/Paris (helpers existants `slotStartDateIsoHeuristicParis`, `parisCalendarDayBoundsUtc`).
- Commits : format `<type>: <description>`, corps avec `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` et `Claude-Session: https://claude.ai/code/session_01FB7HnJmTfJbLtbMKRrxJDZ`.
- Après chaque tâche qui modifie du code : `graphify update .` (AST only) avant le commit final de la tâche (ne pas committer `graphify-out/`, déjà non suivi).
- Immutabilité : pas de mutation d'objets reçus en paramètre ; retourner de nouveaux objets/tableaux.

---

## File Structure

| Fichier | Rôle |
|---------|------|
| `packages/db/src/schema.ts` (modif) | colonnes `cancelReason`, `clubClosureId` sur `jobRuns` |
| `packages/db/src/migrations/0026_late_closure_cancel.sql` (+ journal) | migration générée |
| `apps/worker/src/jobRuns.ts` (modif) | `cancelJobRun(db, jobId, opts?)` étendu |
| `apps/worker/src/closures/filterCandidateTimes.ts` (modif) | `ClosureInterval.label?: string \| null` |
| `apps/worker/src/closures/loadClubClosures.ts` (modif) | renvoie aussi `label` |
| `apps/worker/src/graph/nodes/pollQuestion.ts` (modif) | `buildClubClosedMessage(targetDate, labels)`, `buildClosureCancelMessage(...)` |
| `apps/worker/src/graph/nodes/sendPoll.ts` (modif) | passe les libellés au message cas A |
| `apps/worker/src/closures/closureImpact.ts` (créé) | `computeClosureImpact` pur + types |
| `apps/worker/src/closures/loadClosureImpact.ts` (créé) | charge règles/jobs/statuts, appelle le pur |
| `apps/worker/src/closures/cancelJobForClosure.ts` (créé) | cascade 5 étapes |
| `apps/worker/src/scheduler/scheduler.ts` (modif) | garde-fou `awaitGoAndResume`, `db` propagé |
| `apps/worker/src/http/clubClosuresHandlers.ts` (créé) | handlers `preview` / `create` testables |
| `apps/worker/src/http/server.ts` (modif) | branchement des routes |
| `apps/ui/src/lib/worker.ts` (modif) | `previewClubClosure`, `createClubClosureWithCascade`, types |
| `apps/ui/src/lib/closureImpactLabels.ts` (créé) | libellés d'affichage purs (testables en `.ts`) |
| `apps/ui/src/lib/clubClosures.ts` (modif) | suppression de `createClubClosure` |
| `apps/ui/src/app/actions.ts` (modif) | `previewClubClosureAction`, `confirmClubClosureAction` |
| `apps/ui/src/app/components/ClubClosureAddForm.tsx` (réécrit) | formulaire deux temps |
| `apps/ui/src/app/settings/page.tsx` (modif) | branchement du nouveau formulaire |
| `apps/ui/src/app/rules/[id]/jobs/[jobId]/Pipeline.tsx` (modif) | affichage `cancelReason` |
| `docs/spec/regles-fonctionnelles.md` (modif) | règles fonctionnelles |

---

### Task 1: Schéma — `cancel_reason`, `club_closure_id`, `cancelJobRun` étendu

**Files:**
- Modify: `packages/db/src/schema.ts` (bloc `jobRuns`, vers la ligne 171)
- Create (généré): `packages/db/src/migrations/0026_late_closure_cancel.sql` + `meta/_journal.json` + snapshot
- Modify: `apps/worker/src/jobRuns.ts` (`cancelJobRun`)
- Modify: `apps/worker/src/scheduler/scheduler.test.ts` (fixture `job()`)
- Modify: `apps/ui/src/lib/worker.ts` (interface `JobRun`, ligne ~88)

**Interfaces:**
- Produces: `JobRun.cancelReason: string | null`, `JobRun.clubClosureId: string | null` (Drizzle) ; `cancelJobRun(db, jobId, opts?: { reason: string; clubClosureId: string }): Promise<JobRun | undefined>`.

- [ ] **Step 1: Ajouter les colonnes au schéma**

Dans `packages/db/src/schema.ts`, dans `pgTable("job_runs", {...})`, juste après `cancelledAt: timestamp("cancelled_at"),` :

```ts
  /** Cause d'annulation lisible (ex. « PUC fermé : tournoi »). null pour l'annulation manuelle du sondage. */
  cancelReason: text("cancel_reason"),
  /** Fermeture PUC à l'origine de l'arrêt (historique uniquement, aucun comportement associé). */
  clubClosureId: uuid("club_closure_id").references(() => clubClosures.id, { onDelete: "set null" }),
```

`clubClosures` est déclaré plus bas dans le fichier : la référence dans une arrow function est résolue à l'exécution, c'est le même pattern que `bookingRules` ↔ `jobRuns`. Si `tsc` se plaint d'une utilisation avant déclaration, déplacer le bloc `clubClosures` **au-dessus** du bloc `jobRuns`.

- [ ] **Step 2: Générer la migration**

Run: `npm run db:generate -- --name late_closure_cancel`
Expected: un fichier `packages/db/src/migrations/0026_late_closure_cancel.sql` contenant deux `ALTER TABLE "job_runs" ADD COLUMN ...` et un `ALTER TABLE "job_runs" ADD CONSTRAINT ... FOREIGN KEY ("club_closure_id") REFERENCES "public"."club_closures"("id") ON DELETE set null`. Ajouter en tête du SQL le commentaire :

```sql
-- Fermeture PUC déclarée tardivement (spec 2026-09-12) : cause d'annulation et fermeture d'origine
-- posées par la cascade d'arrêt des jobs en cours. Annulation manuelle du sondage : les deux restent NULL.
```

- [ ] **Step 3: Étendre `cancelJobRun`**

Dans `apps/worker/src/jobRuns.ts`, remplacer la fonction existante :

```ts
/**
 * Annule un job. `opts` renseigné par la cascade « PUC fermé » (cause lisible + fermeture
 * d'origine) ; absent pour l'annulation manuelle du sondage depuis l'UI.
 */
export async function cancelJobRun(
  db: Database,
  jobId: string,
  opts?: { reason: string; clubClosureId: string },
): Promise<JobRun | undefined> {
  const [job] = await db
    .update(jobRuns)
    .set({
      cancelledAt: new Date(),
      cancelReason: opts?.reason ?? null,
      clubClosureId: opts?.clubClosureId ?? null,
    })
    .where(eq(jobRuns.id, jobId))
    .returning();
  return job;
}
```

- [ ] **Step 4: Mettre à jour les fixtures et le miroir UI**

Dans `apps/worker/src/scheduler/scheduler.test.ts`, fonction `job()`, ajouter après `nextDayReminderSentAt: null,` :

```ts
    cancelReason: null,
    clubClosureId: null,
```

Dans `apps/ui/src/lib/worker.ts`, interface `JobRun`, après `cancelledAt: string | null;` :

```ts
  /** Cause lisible de l'annulation (ex. « PUC fermé : tournoi »), null pour une annulation manuelle. */
  cancelReason: string | null;
  clubClosureId: string | null;
```

- [ ] **Step 5: Typecheck et tests**

Run: `npm run typecheck && npm run worker:test`
Expected: PASS (aucune erreur de type, tests existants verts).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/migrations apps/worker/src/jobRuns.ts apps/worker/src/scheduler/scheduler.test.ts apps/ui/src/lib/worker.ts
git commit -m "feat(db): cancel_reason et club_closure_id sur job_runs (fermeture PUC tardive)"
```

---

### Task 2: Messages WhatsApp informels avec raison

**Files:**
- Modify: `apps/worker/src/closures/filterCandidateTimes.ts` (interface `ClosureInterval`)
- Modify: `apps/worker/src/closures/loadClubClosures.ts` + `loadClubClosures.test.ts`
- Modify: `apps/worker/src/graph/nodes/pollQuestion.ts` + `pollQuestion.test.ts`
- Modify: `apps/worker/src/graph/nodes/sendPoll.ts` + `sendPoll.test.ts`

**Interfaces:**
- Produces:
  - `ClosureInterval { startsAt: Date; endsAt: Date; label?: string | null }`
  - `formatClosureReason(labels: Array<string | null | undefined>): string` → `" (tournoi)"` ou `""`.
  - `buildClubClosedMessage(targetDate: string, labels?: Array<string | null | undefined>): string`
  - `buildClosureCancelMessage(targetDate: string, labels: Array<string | null | undefined>, pollDeleted: boolean): string`

- [ ] **Step 1: Tests des textes (RED)**

Dans `apps/worker/src/graph/nodes/pollQuestion.test.ts`, **remplacer** le bloc `describe("buildClubClosedMessage", ...)` par :

```ts
describe("buildClubClosedMessage", () => {
  it("ton informel, date, raison entre parenthèses, pas de sondage cette semaine", () => {
    expect(buildClubClosedMessage("2026-09-19", ["tournoi"])).toBe(
      "Hello la team ! Le PUC est fermé samedi 19 septembre (tournoi), donc pas de squash ce jour-là 😕 Pas de sondage cette semaine, on remet ça la semaine suivante 💪",
    );
  });

  it("sans libellé : pas de parenthèse", () => {
    expect(buildClubClosedMessage("2026-09-19", [null])).toBe(
      "Hello la team ! Le PUC est fermé samedi 19 septembre, donc pas de squash ce jour-là 😕 Pas de sondage cette semaine, on remet ça la semaine suivante 💪",
    );
  });

  it("plusieurs libellés : dédupliqués et joints par « / »", () => {
    expect(buildClubClosedMessage("2026-09-19", ["tournoi", "tournoi", "travaux"])).toContain("(tournoi / travaux)");
  });
});

describe("buildClosureCancelMessage", () => {
  it("sondage supprimé", () => {
    expect(buildClosureCancelMessage("2026-09-19", ["tournoi"], true)).toBe(
      "Hello la team ! Mauvaise nouvelle : le PUC est fermé samedi 19 septembre (tournoi), donc pas de squash ce jour-là 😕 J'ai supprimé le sondage, on remet ça la semaine prochaine 💪",
    );
  });

  it("sondage non supprimable", () => {
    expect(buildClosureCancelMessage("2026-09-19", ["tournoi"], false)).toBe(
      "Hello la team ! Mauvaise nouvelle : le PUC est fermé samedi 19 septembre (tournoi), donc pas de squash ce jour-là 😕 Ignorez le sondage du coup, on remet ça la semaine prochaine 💪",
    );
  });
});
```

Ajouter `buildClosureCancelMessage` à l'import en tête du fichier.

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run src/graph/nodes/pollQuestion.test.ts -w @squash-assistant/worker` (ou depuis `apps/worker` : `npx vitest run src/graph/nodes/pollQuestion.test.ts`)
Expected: FAIL — `buildClosureCancelMessage` n'existe pas, `buildClubClosedMessage` renvoie l'ancien texte.

- [ ] **Step 3: Implémenter les textes**

Dans `apps/worker/src/graph/nodes/pollQuestion.ts`, remplacer `buildClubClosedMessage` par :

```ts
/** « (tournoi / travaux) » à partir des libellés de fermeture, dédupliqués ; chaîne vide sans libellé. */
export function formatClosureReason(labels: Array<string | null | undefined>): string {
  const unique = [...new Set(labels.map((l) => l?.trim()).filter((l): l is string => Boolean(l)))];
  return unique.length === 0 ? "" : ` (${unique.join(" / ")})`;
}

/** Message envoyé à la place du sondage quand la date cible est déjà fermée (cas A du design 2026-08-09). */
export function buildClubClosedMessage(targetDate: string, labels: Array<string | null | undefined> = []): string {
  return `Hello la team ! Le PUC est fermé ${formatInformalDate(targetDate)}${formatClosureReason(labels)}, donc pas de squash ce jour-là 😕 Pas de sondage cette semaine, on remet ça la semaine suivante 💪`;
}

/** Message envoyé quand une fermeture déclarée après coup arrête un job en cours (spec 2026-09-12). */
export function buildClosureCancelMessage(
  targetDate: string,
  labels: Array<string | null | undefined>,
  pollDeleted: boolean,
): string {
  const tail = pollDeleted ? "J'ai supprimé le sondage" : "Ignorez le sondage du coup";
  return `Hello la team ! Mauvaise nouvelle : le PUC est fermé ${formatInformalDate(targetDate)}${formatClosureReason(labels)}, donc pas de squash ce jour-là 😕 ${tail}, on remet ça la semaine prochaine 💪`;
}
```

- [ ] **Step 4: Tests verts**

Run: `cd apps/worker && npx vitest run src/graph/nodes/pollQuestion.test.ts`
Expected: PASS.

- [ ] **Step 5: `ClosureInterval` porte le libellé, `loadClubClosuresForDate` le renvoie (RED puis GREEN)**

Dans `apps/worker/src/closures/filterCandidateTimes.ts` :

```ts
export interface ClosureInterval {
  startsAt: Date;
  endsAt: Date;
  /** Libellé de la fermeture (raison), utilisé dans les messages WhatsApp. */
  label?: string | null;
}
```

Dans `apps/worker/src/closures/loadClubClosures.test.ts`, remplacer l'assertion finale par :

```ts
    await expect(loadClubClosuresForDate(db as never, "2026-08-15")).resolves.toEqual([
      { startsAt, endsAt, label: "Jour férié" },
    ]);
```

et le titre du test par `"retourne bornes et libellé des fermetures qui chevauchent la date"`.

Run: `cd apps/worker && npx vitest run src/closures/loadClubClosures.test.ts` → FAIL.

Dans `loadClubClosures.ts`, dernière ligne :

```ts
  return rows.map(({ startsAt, endsAt, label }) => ({ startsAt, endsAt, label }));
```

Run à nouveau → PASS.

- [ ] **Step 6: SendPoll cas A utilise les libellés (RED puis GREEN)**

Dans `apps/worker/src/graph/nodes/sendPoll.test.ts`, premier test (`"envoie un message et termine sans sondage..."`) :

```ts
    const closures = [
      { startsAt: new Date("2026-08-14T22:00:00.000Z"), endsAt: new Date("2026-08-15T22:00:00.000Z"), label: "15 août" },
    ];
```

et l'assertion `sendMessage` :

```ts
    expect(sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "group@test",
      "Hello la team ! Le PUC est fermé samedi 15 août (15 août), donc pas de squash ce jour-là 😕 Pas de sondage cette semaine, on remet ça la semaine suivante 💪",
    );
```

Adapter le type de `deps(closures: Array<{ startsAt: Date; endsAt: Date; label?: string | null }>)`.

Run: `cd apps/worker && npx vitest run src/graph/nodes/sendPoll.test.ts` → FAIL.

Dans `sendPoll.ts`, remplacer `const message = buildClubClosedMessage(targetDate);` par :

```ts
      const message = buildClubClosedMessage(
        targetDate,
        closures.map((c) => c.label),
      );
```

Run à nouveau → PASS.

- [ ] **Step 7: Suite complète + commit**

Run: `npm run worker:test && npm run typecheck`
Expected: PASS.

```bash
git add apps/worker/src/closures apps/worker/src/graph/nodes/pollQuestion.ts apps/worker/src/graph/nodes/pollQuestion.test.ts apps/worker/src/graph/nodes/sendPoll.ts apps/worker/src/graph/nodes/sendPoll.test.ts
git commit -m "feat(poll): messages de fermeture PUC informels avec la raison"
```

---

### Task 3: `computeClosureImpact` (fonction pure)

**Files:**
- Create: `apps/worker/src/closures/closureImpact.ts`
- Test: `apps/worker/src/closures/closureImpact.test.ts`

**Interfaces:**
- Consumes: `filterCandidateTimesByClosures` (Task 2), `PipelineStage` de `../scheduler/scheduler.js`, `parisCalendarDayBoundsUtc` de `../scheduler/weekKey.js`.
- Produces:

```ts
export interface ClosureImpactEntry {
  ruleId: string;
  ruleLabel: string;
  jobId: string | null;
  targetDate: string;
  stage: PipelineStage | "not-created";
  closedTimes: string[];
}
export interface ClosureImpact {
  running: ClosureImpactEntry[];
  planned: ClosureImpactEntry[];
  errored: ClosureImpactEntry[];
}
export interface JobWithStage { job: JobRun; stage: PipelineStage }
export function computeClosureImpact(
  interval: ClosureInterval,
  rules: BookingRule[],
  jobs: JobWithStage[],
  now: Date,
): ClosureImpact
export function targetDatesInInterval(interval: ClosureInterval, targetWeekday: number, now: Date): string[]
```

- [ ] **Step 1: Tests (RED)**

Créer `apps/worker/src/closures/closureImpact.test.ts` :

```ts
import { describe, expect, it } from "vitest";
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import { computeClosureImpact, targetDatesInInterval } from "./closureImpact.js";

function rule(overrides: Partial<BookingRule> = {}): BookingRule {
  return {
    id: "rule-sam",
    name: "Samedi",
    enabled: true,
    whatsappGroupJid: "g@test",
    resaSquashGroupId: "resa-1",
    targetWeekday: 6,
    pollDaysBefore: 7,
    pollTime: "10:00",
    decisionDaysBefore: 4,
    decisionTime: "21:30",
    candidateStartTimes: ["18H45", "19H30"],
    maxCourtsPerSlot: 3,
    minPlayersPerCourt: 2,
    maxPlayersPerCourt: 3,
    maxReservationsPerPlayer: 2,
    priorityBookers: [],
    preferMinPlayersPerCourt: true,
    courtPriority: [4, 3, 2, 1],
    availabilityWindowHours: 3,
    description: null,
    substituteBookers: [],
    maxDailyReservationsPerPlayer: 2,
    unexpectedPlayersMargin: 0,
    reservationNotifyWhatsappGroupJid: null,
    cronJitterWindowMinutes: 60,
    requireTelegramGoForAutoJobs: true,
    nextDayReminderEnabled: false,
    jokerBookerId: null,
    ...overrides,
  };
}

function job(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: "job-1",
    bookingRuleId: "rule-sam",
    targetDate: "2026-09-19",
    candidateStartTimes: null,
    pollRequestId: "poll-1",
    pollMsgId: "msg-1",
    ruleSnapshot: null,
    cancelledAt: null,
    cancelReason: null,
    clubClosureId: null,
    auto: true,
    nextDayReminderSentAt: null,
    createdAt: new Date("2026-09-12T08:00:00Z"),
    ...overrides,
  };
}

// Samedi 19 septembre 2026, journée entière Paris (CEST = UTC+2)
const wholeDay = { startsAt: new Date("2026-09-18T22:00:00Z"), endsAt: new Date("2026-09-19T22:00:00Z"), label: "tournoi" };
// Samedi 19 septembre 2026, 18:00 → 19:00 Paris : couvre 18H45 mais pas 19H30
const partial = { startsAt: new Date("2026-09-19T16:00:00Z"), endsAt: new Date("2026-09-19T17:00:00Z"), label: "tournoi" };
const now = new Date("2026-09-12T10:00:00Z");

describe("computeClosureImpact", () => {
  it("journée entière : job en cours (awaiting-decision) → running avec toutes les heures fermées", () => {
    const impact = computeClosureImpact(wholeDay, [rule()], [{ job: job(), stage: "awaiting-decision" }], now);
    expect(impact.running).toEqual([
      { ruleId: "rule-sam", ruleLabel: "Samedi", jobId: "job-1", targetDate: "2026-09-19", stage: "awaiting-decision", closedTimes: ["18H45", "19H30"] },
    ]);
    expect(impact.planned).toEqual([]);
    expect(impact.errored).toEqual([]);
  });

  it("fermeture partielle couvrant une heure sur deux → running (une heure suffit)", () => {
    const impact = computeClosureImpact(partial, [rule()], [{ job: job(), stage: "awaiting-go" }], now);
    expect(impact.running).toHaveLength(1);
    expect(impact.running[0]!.closedTimes).toEqual(["18H45"]);
  });

  it("fermeture ne couvrant aucune heure candidate → rien", () => {
    const outside = { startsAt: new Date("2026-09-19T08:00:00Z"), endsAt: new Date("2026-09-19T10:00:00Z") };
    const impact = computeClosureImpact(outside, [rule()], [{ job: job(), stage: "awaiting-decision" }], now);
    expect(impact).toEqual({ running: [], planned: [], errored: [] });
  });

  it("les heures candidates du job priment sur celles de la règle", () => {
    const impact = computeClosureImpact(
      partial,
      [rule()],
      [{ job: job({ candidateStartTimes: ["19H30"] }), stage: "awaiting-decision" }],
      now,
    );
    expect(impact.running).toEqual([]);
  });

  it("job annulé ou terminé : ignoré", () => {
    const impact = computeClosureImpact(
      wholeDay,
      [rule()],
      [
        { job: job({ id: "j-cancelled", cancelledAt: new Date() }), stage: "awaiting-decision" },
        { job: job({ id: "j-done" }), stage: "finished-announced" },
        { job: job({ id: "j-closed" }), stage: "finished-club-closed" },
      ],
      now,
    );
    expect(impact).toEqual({ running: [], planned: [], errored: [] });
  });

  it("job en erreur → errored, sans action", () => {
    const impact = computeClosureImpact(wholeDay, [rule()], [{ job: job(), stage: "error" }], now);
    expect(impact.errored.map((e) => e.jobId)).toEqual(["job-1"]);
    expect(impact.running).toEqual([]);
  });

  it("job not-started existant → planned", () => {
    const impact = computeClosureImpact(
      wholeDay,
      [rule()],
      [{ job: job({ pollRequestId: null, pollMsgId: null }), stage: "not-started" }],
      now,
    );
    expect(impact.planned).toEqual([
      { ruleId: "rule-sam", ruleLabel: "Samedi", jobId: "job-1", targetDate: "2026-09-19", stage: "not-started", closedTimes: ["18H45", "19H30"] },
    ]);
  });

  it("règle active sans job pour la date cible couverte → planned avec jobId null", () => {
    const impact = computeClosureImpact(wholeDay, [rule()], [], now);
    expect(impact.planned).toEqual([
      { ruleId: "rule-sam", ruleLabel: "Samedi", jobId: null, targetDate: "2026-09-19", stage: "not-created", closedTimes: ["18H45", "19H30"] },
    ]);
  });

  it("règle désactivée : jamais listée sans job", () => {
    const impact = computeClosureImpact(wholeDay, [rule({ enabled: false })], [], now);
    expect(impact.planned).toEqual([]);
  });

  it("règle avec un job existant pour la date : pas de doublon « not-created »", () => {
    const impact = computeClosureImpact(wholeDay, [rule()], [{ job: job(), stage: "awaiting-decision" }], now);
    expect(impact.planned).toEqual([]);
  });

  it("ruleLabel retombe sur l'id si la règle n'a pas de nom", () => {
    const impact = computeClosureImpact(wholeDay, [rule({ name: null })], [], now);
    expect(impact.planned[0]!.ruleLabel).toBe("rule-sam");
  });
});

describe("targetDatesInInterval", () => {
  it("liste les samedis futurs couverts par l'intervalle (jour Paris)", () => {
    const twoWeeks = { startsAt: new Date("2026-09-18T22:00:00Z"), endsAt: new Date("2026-10-03T22:00:00Z") };
    expect(targetDatesInInterval(twoWeeks, 6, now)).toEqual(["2026-09-19", "2026-09-26", "2026-10-03"]);
  });

  it("exclut les dates passées", () => {
    expect(targetDatesInInterval(wholeDay, 6, new Date("2026-09-20T10:00:00Z"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `cd apps/worker && npx vitest run src/closures/closureImpact.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

Créer `apps/worker/src/closures/closureImpact.ts` :

```ts
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { PipelineStage } from "../scheduler/scheduler.js";
import { parisCalendarDayBoundsUtc } from "../scheduler/weekKey.js";
import { filterCandidateTimesByClosures, type ClosureInterval } from "./filterCandidateTimes.js";

export interface ClosureImpactEntry {
  ruleId: string;
  /** Nom de la règle, repli sur son id — pour l'affichage dans l'aperçu UI. */
  ruleLabel: string;
  /** null : règle sans job encore créé pour cette date cible. */
  jobId: string | null;
  targetDate: string;
  stage: PipelineStage | "not-created";
  closedTimes: string[];
}

export interface ClosureImpact {
  /** Jobs en cours qui seront arrêtés par la cascade. */
  running: ClosureImpactEntry[];
  /** Jobs / règles qui recevront le message de fermeture à la place du sondage — information seulement. */
  planned: ClosureImpactEntry[];
  /** Jobs en stage `error` couverts — à annuler à la main, aucune action automatique. */
  errored: ClosureImpactEntry[];
}

export interface JobWithStage {
  job: JobRun;
  stage: PipelineStage;
}

const RUNNING_STAGES: ReadonlySet<PipelineStage> = new Set(["awaiting-decision", "awaiting-plan", "awaiting-go"]);
/** Borne de sécurité sur l'énumération des jours d'un intervalle (les fermetures sont courtes). */
const MAX_DAYS_SCANNED = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function ruleLabel(rule: BookingRule): string {
  return rule.name?.trim() || rule.id;
}

function parisYmd(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/**
 * Dates cibles (YYYY-MM-DD, Paris) d'un jour de semaine donné, strictement après
 * aujourd'hui, dont la journée chevauche l'intervalle de fermeture.
 */
export function targetDatesInInterval(interval: ClosureInterval, targetWeekday: number, now: Date): string[] {
  const today = parisYmd(now);
  const dates: string[] = [];
  let cursor = new Date(`${parisYmd(interval.startsAt)}T12:00:00Z`);
  for (let i = 0; i < MAX_DAYS_SCANNED; i += 1) {
    const ymd = cursor.toISOString().slice(0, 10);
    const { start } = parisCalendarDayBoundsUtc(ymd);
    if (start.getTime() >= interval.endsAt.getTime()) break;
    if (ymd > today && cursor.getUTCDay() === targetWeekday) dates.push(ymd);
    cursor = new Date(cursor.getTime() + DAY_MS);
  }
  return dates;
}

function closedTimesFor(interval: ClosureInterval, targetDate: string, times: string[]): string[] {
  return filterCandidateTimesByClosures(targetDate, times, [interval]).closedTimes;
}

/**
 * Détection pure de l'impact d'une fermeture (spec 2026-09-12) : un job est impacté dès
 * qu'UNE de ses heures candidates tombe dans l'intervalle — fermeture partielle ou journée entière.
 */
export function computeClosureImpact(
  interval: ClosureInterval,
  rules: BookingRule[],
  jobs: JobWithStage[],
  now: Date,
): ClosureImpact {
  const rulesById = new Map(rules.map((r) => [r.id, r]));
  const running: ClosureImpactEntry[] = [];
  const planned: ClosureImpactEntry[] = [];
  const errored: ClosureImpactEntry[] = [];
  const datesWithJob = new Set<string>();

  for (const { job, stage } of jobs) {
    const rule = rulesById.get(job.bookingRuleId);
    if (!rule || job.cancelledAt) continue;
    datesWithJob.add(`${rule.id}:${job.targetDate}`);
    const times = job.candidateStartTimes ?? rule.candidateStartTimes;
    const closedTimes = closedTimesFor(interval, job.targetDate, times);
    if (closedTimes.length === 0) continue;
    const entry: ClosureImpactEntry = {
      ruleId: rule.id,
      ruleLabel: ruleLabel(rule),
      jobId: job.id,
      targetDate: job.targetDate,
      stage,
      closedTimes,
    };
    if (RUNNING_STAGES.has(stage)) running.push(entry);
    else if (stage === "error") errored.push(entry);
    else if (stage === "not-started") planned.push(entry);
  }

  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const targetDate of targetDatesInInterval(interval, rule.targetWeekday, now)) {
      if (datesWithJob.has(`${rule.id}:${targetDate}`)) continue;
      const closedTimes = closedTimesFor(interval, targetDate, rule.candidateStartTimes);
      if (closedTimes.length === 0) continue;
      planned.push({ ruleId: rule.id, ruleLabel: ruleLabel(rule), jobId: null, targetDate, stage: "not-created", closedTimes });
    }
  }

  return { running, planned, errored };
}
```

- [ ] **Step 4: Tests verts**

Run: `cd apps/worker && npx vitest run src/closures/closureImpact.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/closures/closureImpact.ts apps/worker/src/closures/closureImpact.test.ts
git commit -m "feat(closures): détection pure de l'impact d'une fermeture sur les jobs"
```

---

### Task 4: `loadClosureImpact` (DB + LangGraph)

**Files:**
- Create: `apps/worker/src/closures/loadClosureImpact.ts`
- Test: `apps/worker/src/closures/loadClosureImpact.test.ts`

**Interfaces:**
- Consumes: `computeClosureImpact`, `loadBookingRules(db)` (`../bookingRules.js`), `listJobRuns(db, ruleId)` (`../jobRuns.js`), `getJobExecutionStatus(rule, job, graph)` (`../scheduler/scheduler.js`), `parisCalendarDayBoundsUtc`.
- Produces: `loadClosureImpact(deps: { db: Database; graph: PipelineGraph }, interval: ClosureInterval, now?: Date): Promise<ClosureImpact>`.

- [ ] **Step 1: Test (RED)**

Créer `apps/worker/src/closures/loadClosureImpact.test.ts` :

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../bookingRules.js", () => ({ loadBookingRules: vi.fn() }));
vi.mock("../jobRuns.js", () => ({ listJobRuns: vi.fn() }));
vi.mock("../scheduler/scheduler.js", () => ({ getJobExecutionStatus: vi.fn() }));

const { loadBookingRules } = await import("../bookingRules.js");
const { listJobRuns } = await import("../jobRuns.js");
const { getJobExecutionStatus } = await import("../scheduler/scheduler.js");
const { loadClosureImpact } = await import("./loadClosureImpact.js");

const wholeDay = { startsAt: new Date("2026-09-18T22:00:00Z"), endsAt: new Date("2026-09-19T22:00:00Z"), label: "tournoi" };
const now = new Date("2026-09-12T10:00:00Z");

describe("loadClosureImpact", () => {
  it("n'interroge LangGraph que pour les jobs dont la date cible est proche de l'intervalle", async () => {
    vi.mocked(loadBookingRules).mockResolvedValue([
      { id: "rule-sam", name: "Samedi", enabled: true, targetWeekday: 6, candidateStartTimes: ["18H45"] } as never,
    ]);
    vi.mocked(listJobRuns).mockResolvedValue([
      { id: "old", bookingRuleId: "rule-sam", targetDate: "2026-06-06", cancelledAt: null, candidateStartTimes: null } as never,
      { id: "j19", bookingRuleId: "rule-sam", targetDate: "2026-09-19", cancelledAt: null, candidateStartTimes: null } as never,
      { id: "cancelled", bookingRuleId: "rule-sam", targetDate: "2026-09-19", cancelledAt: new Date(), candidateStartTimes: null } as never,
    ]);
    vi.mocked(getJobExecutionStatus).mockResolvedValue({ stage: "awaiting-decision" } as never);

    const impact = await loadClosureImpact({ db: {} as never, graph: {} as never }, wholeDay, now);

    expect(getJobExecutionStatus).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getJobExecutionStatus).mock.calls[0]![1]).toMatchObject({ id: "j19" });
    expect(impact.running.map((e) => e.jobId)).toEqual(["j19"]);
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `cd apps/worker && npx vitest run src/closures/loadClosureImpact.test.ts` → FAIL (module introuvable).

- [ ] **Step 3: Implémenter**

Créer `apps/worker/src/closures/loadClosureImpact.ts` :

```ts
import type { Database } from "@squash-assistant/db/client";
import { loadBookingRules } from "../bookingRules.js";
import type { PipelineGraph } from "../graph/buildGraph.js";
import { listJobRuns } from "../jobRuns.js";
import { getJobExecutionStatus } from "../scheduler/scheduler.js";
import { parisCalendarDayBoundsUtc } from "../scheduler/weekKey.js";
import { computeClosureImpact, type ClosureImpact, type JobWithStage } from "./closureImpact.js";
import type { ClosureInterval } from "./filterCandidateTimes.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Marge d'un jour de part et d'autre : évite d'interroger Redis pour tout l'historique des jobs. */
function isNearInterval(targetDate: string, interval: ClosureInterval): boolean {
  const { start, end } = parisCalendarDayBoundsUtc(targetDate);
  return end.getTime() + DAY_MS > interval.startsAt.getTime() && start.getTime() - DAY_MS < interval.endsAt.getTime();
}

/** Charge règles, jobs proches de l'intervalle et leur stage LangGraph, puis délègue au calcul pur. */
export async function loadClosureImpact(
  deps: { db: Database; graph: PipelineGraph },
  interval: ClosureInterval,
  now: Date = new Date(),
): Promise<ClosureImpact> {
  const rules = await loadBookingRules(deps.db);
  const jobsWithStage: JobWithStage[] = [];
  for (const rule of rules) {
    const jobs = await listJobRuns(deps.db, rule.id);
    for (const job of jobs) {
      if (job.cancelledAt || !isNearInterval(job.targetDate, interval)) continue;
      const status = await getJobExecutionStatus(rule, job, deps.graph);
      jobsWithStage.push({ job, stage: status.stage });
    }
  }
  return computeClosureImpact(interval, rules, jobsWithStage, now);
}
```

- [ ] **Step 4: Tests verts + commit**

Run: `cd apps/worker && npx vitest run src/closures/loadClosureImpact.test.ts` → PASS.

```bash
git add apps/worker/src/closures/loadClosureImpact.ts apps/worker/src/closures/loadClosureImpact.test.ts
git commit -m "feat(closures): chargement de l'impact d'une fermeture (DB + LangGraph)"
```

---

### Task 5: Cascade `cancelJobForClosure`

**Files:**
- Create: `apps/worker/src/closures/cancelJobForClosure.ts`
- Test: `apps/worker/src/closures/cancelJobForClosure.test.ts`

**Interfaces:**
- Consumes: `deleteMessage`, `sendMessage` (`../mcp/huddleBot.js`), `cancelJobRun(db, jobId, { reason, clubClosureId })` (Task 1), `emitEvent` (`../graph/emitEvent.js`), `sendTelegramMessage`, `buildClosureCancelMessage` (Task 2), `ClosureImpactEntry` (Task 3).
- Produces:

```ts
export interface ClosureForCancel { id: string; label: string | null }
export type CancelJobForClosureResult =
  | { ok: true; jobId: string; pollDeleted: boolean }
  | { ok: false; jobId: string; error: string; pollDeleted: boolean };
export function cancelJobForClosure(
  deps: GraphDependencies,
  rule: BookingRule,
  job: JobRun,
  entry: ClosureImpactEntry,
  closure: ClosureForCancel,
): Promise<CancelJobForClosureResult>
```

- [ ] **Step 1: Tests (RED)**

Créer `apps/worker/src/closures/cancelJobForClosure.test.ts` :

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../graph/dependencies.js";
import type { ClosureImpactEntry } from "./closureImpact.js";

vi.mock("../mcp/huddleBot.js", () => ({
  deleteMessage: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => {}),
}));
vi.mock("../jobRuns.js", () => ({ cancelJobRun: vi.fn(async () => ({})) }));
vi.mock("../graph/emitEvent.js", () => ({ emitEvent: vi.fn(async () => {}) }));
vi.mock("../telegram/telegram.js", () => ({ sendTelegramMessage: vi.fn(async () => {}) }));

const { deleteMessage, sendMessage } = await import("../mcp/huddleBot.js");
const { cancelJobRun } = await import("../jobRuns.js");
const { emitEvent } = await import("../graph/emitEvent.js");
const { sendTelegramMessage } = await import("../telegram/telegram.js");
const { cancelJobForClosure } = await import("./cancelJobForClosure.js");

const rule = { id: "rule-sam", name: "Samedi", whatsappGroupJid: "g@test" } as BookingRule;
function job(overrides: Partial<JobRun> = {}): JobRun {
  return { id: "job-1", bookingRuleId: "rule-sam", targetDate: "2026-09-19", pollMsgId: "msg-1", ...overrides } as JobRun;
}
const entry: ClosureImpactEntry = {
  ruleId: "rule-sam",
  ruleLabel: "Samedi",
  jobId: "job-1",
  targetDate: "2026-09-19",
  stage: "awaiting-decision",
  closedTimes: ["18H45", "19H30"],
};
const closure = { id: "closure-1", label: "tournoi" };
const deps = {
  huddleBot: { client: {} as never, close: async () => {} },
  resaSquash: { client: {} as never, close: async () => {} },
  telegram: { botToken: "t", chatId: "c" },
  db: {} as never,
} as GraphDependencies;

const EXPECTED_MSG_DELETED =
  "Hello la team ! Mauvaise nouvelle : le PUC est fermé samedi 19 septembre (tournoi), donc pas de squash ce jour-là 😕 J'ai supprimé le sondage, on remet ça la semaine prochaine 💪";

describe("cancelJobForClosure", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ordre nominal : delete_message → send_message → cancelJobRun → event success → Telegram", async () => {
    const calls: string[] = [];
    vi.mocked(deleteMessage).mockImplementation(async () => { calls.push("delete"); });
    vi.mocked(sendMessage).mockImplementation(async () => { calls.push("send"); });
    vi.mocked(cancelJobRun).mockImplementation(async () => { calls.push("cancel"); return {} as never; });
    vi.mocked(emitEvent).mockImplementation(async () => { calls.push("event"); });
    vi.mocked(sendTelegramMessage).mockImplementation(async () => { calls.push("telegram"); });

    const result = await cancelJobForClosure(deps, rule, job(), entry, closure);

    expect(result).toEqual({ ok: true, jobId: "job-1", pollDeleted: true });
    expect(calls).toEqual(["delete", "send", "cancel", "event", "telegram"]);
    expect(deleteMessage).toHaveBeenCalledWith(deps.huddleBot.client, "g@test", "msg-1");
    expect(sendMessage).toHaveBeenCalledWith(deps.huddleBot.client, "g@test", EXPECTED_MSG_DELETED);
    expect(cancelJobRun).toHaveBeenCalledWith(deps.db, "job-1", { reason: "PUC fermé : tournoi", clubClosureId: "closure-1" });
    expect(emitEvent).toHaveBeenCalledWith(deps.db, {
      bookingRuleId: "rule-sam",
      jobRunId: "job-1",
      type: "club-closed",
      status: "success",
      targetDate: "2026-09-19",
      detail: { closureId: "closure-1", label: "tournoi", stage: "awaiting-decision", pollDeleted: true, message: EXPECTED_MSG_DELETED, closedTimes: ["18H45", "19H30"] },
    });
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      deps.telegram,
      "[rule-sam] PUC fermé le 2026-09-19 (tournoi) — job job-1 arrêté à l'étape awaiting-decision, sondage supprimé : oui",
    );
  });

  it("pollMsgId absent : pas de delete, message « ignorez le sondage », pollDeleted false", async () => {
    const result = await cancelJobForClosure(deps, rule, job({ pollMsgId: null }), entry, closure);

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.anything(), "g@test", expect.stringContaining("Ignorez le sondage du coup"));
    expect(result).toEqual({ ok: true, jobId: "job-1", pollDeleted: false });
  });

  it("delete_message en échec : non bloquant, pollDeleted false", async () => {
    vi.mocked(deleteMessage).mockRejectedValue(new Error("boom"));

    const result = await cancelJobForClosure(deps, rule, job(), entry, closure);

    expect(sendMessage).toHaveBeenCalled();
    expect(cancelJobRun).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, jobId: "job-1", pollDeleted: false });
    expect(sendTelegramMessage).toHaveBeenCalledWith(deps.telegram, expect.stringContaining("sondage supprimé : non"));
  });

  it("send_message en échec : job quand même annulé, event error, résultat ok:false", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new Error("whatsapp down"));

    const result = await cancelJobForClosure(deps, rule, job(), entry, closure);

    expect(cancelJobRun).toHaveBeenCalledWith(deps.db, "job-1", { reason: "PUC fermé : tournoi", clubClosureId: "closure-1" });
    expect(emitEvent).toHaveBeenCalledWith(deps.db, expect.objectContaining({ status: "error", detail: expect.objectContaining({ error: "whatsapp down", step: "send_message" }) }));
    expect(result).toEqual({ ok: false, jobId: "job-1", error: "whatsapp down", pollDeleted: true });
  });

  it("sans libellé : raison générique", async () => {
    await cancelJobForClosure(deps, rule, job(), entry, { id: "closure-1", label: null });
    expect(cancelJobRun).toHaveBeenCalledWith(deps.db, "job-1", { reason: "PUC fermé", clubClosureId: "closure-1" });
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `cd apps/worker && npx vitest run src/closures/cancelJobForClosure.test.ts` → FAIL (module introuvable).

- [ ] **Step 3: Implémenter**

Créer `apps/worker/src/closures/cancelJobForClosure.ts` :

```ts
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../graph/dependencies.js";
import { emitEvent } from "../graph/emitEvent.js";
import { buildClosureCancelMessage } from "../graph/nodes/pollQuestion.js";
import { cancelJobRun } from "../jobRuns.js";
import { deleteMessage, sendMessage } from "../mcp/huddleBot.js";
import { sendTelegramMessage } from "../telegram/telegram.js";
import type { ClosureImpactEntry } from "./closureImpact.js";

export interface ClosureForCancel {
  id: string;
  label: string | null;
}

export type CancelJobForClosureResult =
  | { ok: true; jobId: string; pollDeleted: boolean }
  | { ok: false; jobId: string; error: string; pollDeleted: boolean };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function closureCancelReason(label: string | null): string {
  const trimmed = label?.trim();
  return trimmed ? `PUC fermé : ${trimmed}` : "PUC fermé";
}

/**
 * Arrêt d'un job en cours suite à une fermeture PUC déclarée après coup (spec 2026-09-12).
 * Ordre strict : suppression du sondage (best effort) → message WhatsApp → annulation du job
 * (TOUJOURS, même si le message a échoué : le job ne doit pas continuer) → événement → Telegram.
 * Les réservations TeamR ne sont jamais touchées.
 */
export async function cancelJobForClosure(
  deps: GraphDependencies,
  rule: BookingRule,
  job: JobRun,
  entry: ClosureImpactEntry,
  closure: ClosureForCancel,
): Promise<CancelJobForClosureResult> {
  const groupJid = rule.whatsappGroupJid;

  let pollDeleted = false;
  if (job.pollMsgId) {
    try {
      await deleteMessage(deps.huddleBot.client, groupJid, job.pollMsgId);
      pollDeleted = true;
    } catch {
      pollDeleted = false;
    }
  }

  const message = buildClosureCancelMessage(job.targetDate, [closure.label], pollDeleted);
  let sendError: string | undefined;
  try {
    await sendMessage(deps.huddleBot.client, groupJid, message);
  } catch (err) {
    sendError = errorMessage(err);
  }

  await cancelJobRun(deps.db, job.id, { reason: closureCancelReason(closure.label), clubClosureId: closure.id });

  const baseDetail = {
    closureId: closure.id,
    label: closure.label,
    stage: entry.stage,
    pollDeleted,
    message,
    closedTimes: entry.closedTimes,
  };
  await emitEvent(deps.db, {
    bookingRuleId: rule.id,
    jobRunId: job.id,
    type: "club-closed",
    status: sendError ? "error" : "success",
    targetDate: job.targetDate,
    detail: sendError ? { ...baseDetail, step: "send_message", error: sendError } : baseDetail,
  });

  const reason = closure.label?.trim() ? ` (${closure.label.trim()})` : "";
  await sendTelegramMessage(
    deps.telegram,
    `[${rule.id}] PUC fermé le ${job.targetDate}${reason} — job ${job.id} arrêté à l'étape ${entry.stage}, sondage supprimé : ${pollDeleted ? "oui" : "non"}${sendError ? ` — message WhatsApp en échec : ${sendError}` : ""}`,
  );

  if (sendError) return { ok: false, jobId: job.id, error: sendError, pollDeleted };
  return { ok: true, jobId: job.id, pollDeleted };
}
```

Note : dans le test nominal, l'assertion Telegram compare la chaîne exacte **sans** suffixe d'erreur — c'est bien ce que produit le code quand `sendError` est `undefined`.

- [ ] **Step 4: Tests verts + commit**

Run: `cd apps/worker && npx vitest run src/closures/cancelJobForClosure.test.ts` → PASS (5 tests).

```bash
git add apps/worker/src/closures/cancelJobForClosure.ts apps/worker/src/closures/cancelJobForClosure.test.ts
git commit -m "feat(closures): cascade d'arrêt d'un job en cours pour fermeture PUC"
```

---

### Task 6: Garde-fou « go » Telegram sur job annulé

**Files:**
- Modify: `apps/worker/src/scheduler/scheduler.ts` (`triggerPlan`, `triggerRecomputePlan`, `triggerRetry`, `resumeAfterPlanInterrupt`, `awaitGoAndResume`, `triggerCronDecision`, `recoverPendingGoWaits`)
- Modify: `apps/worker/src/http/server.ts` (appels lignes ~380-384)
- Test: `apps/worker/src/scheduler/scheduler.test.ts`

**Interfaces:**
- Produces (signatures modifiées, `db` en dernier paramètre) :
  - `triggerPlan(rule, job, graph, telegram, db)`
  - `triggerRecomputePlan(rule, job, graph, telegram, db)`
  - `triggerRetry(rule, job, graph, telegram, db)`
  - `resumeAfterPlanInterrupt(rule, job, graph, telegram, config, db)`

- [ ] **Step 1: Test (RED)**

Dans `apps/worker/src/scheduler/scheduler.test.ts` :

1. Dans le `vi.mock("../jobRuns.js", ...)`, ajouter `getJobRunById: vi.fn(),` à côté de `findActiveJobRunForDate`.
2. Ajouter un mock de `waitForGoConfirmation` dans le `vi.mock("../telegram/telegram.js", ...)` : `return { ...actual, sendTelegramMessage: vi.fn(async () => {}), waitForGoConfirmation: vi.fn(async () => true) };`
3. Importer `getJobRunById` depuis `../jobRuns.js` et `waitForGoConfirmation` depuis `../telegram/telegram.js`.
4. Mettre à jour les deux appels existants de `resumeAfterPlanInterrupt(..., config)` en `resumeAfterPlanInterrupt(..., config, {} as never)`.
5. Ajouter dans `describe("resumeAfterPlanInterrupt", ...)` :

```ts
  it("« go » Telegram reçu après annulation du job → ne reprend pas le graphe et logue", async () => {
    const invoke = vi.fn();
    const graph = { invoke } as unknown as PipelineGraph;
    const telegram = { botToken: "t", chatId: "c" };
    const config = { configurable: { thread_id: "test:job-1" } };
    vi.mocked(waitForGoConfirmation).mockResolvedValue(true);
    vi.mocked(getJobRunById).mockResolvedValue(
      job({ cancelledAt: new Date("2026-09-12T10:00:00Z"), cancelReason: "PUC fermé : tournoi" }),
    );

    await resumeAfterPlanInterrupt(rule({ requireTelegramGoForAutoJobs: true }), job(), graph, telegram, config, {} as never);
    await vi.waitFor(() => expect(sendTelegramMessage).toHaveBeenCalledWith(telegram, expect.stringContaining("\"go\" ignoré")));

    expect(invoke).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledWith(telegram, '[test-rule] "go" ignoré — job du 2026-08-11 annulé (PUC fermé : tournoi).');
  });

  it("« go » Telegram sur un job toujours actif → reprend le graphe", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const graph = { invoke } as unknown as PipelineGraph;
    const telegram = { botToken: "t", chatId: "c" };
    const config = { configurable: { thread_id: "test:job-1" } };
    vi.mocked(waitForGoConfirmation).mockResolvedValue(true);
    vi.mocked(getJobRunById).mockResolvedValue(job());

    await resumeAfterPlanInterrupt(rule({ requireTelegramGoForAutoJobs: true }), job(), graph, telegram, config, {} as never);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    expect(invoke).toHaveBeenCalledWith(new Command({ resume: "go-real" }), config);
  });
```

Attention : le test existant « job auto + requireTelegramGoForAutoJobs=true → n'appelle pas invoke » repose sur le fait que le polling ne rend pas la main ; avec `waitForGoConfirmation` mocké à `true`, il faut lui fournir `vi.mocked(getJobRunById).mockResolvedValue(job())` **et** changer son attente : il devient redondant avec le test « job toujours actif ». Le supprimer.

- [ ] **Step 2: Vérifier l'échec**

Run: `cd apps/worker && npx vitest run src/scheduler/scheduler.test.ts`
Expected: FAIL (erreur de type sur le 6e argument / `getJobRunById` jamais appelé / `invoke` appelé sur job annulé).

- [ ] **Step 3: Implémenter**

Dans `apps/worker/src/scheduler/scheduler.ts` :

1. Importer `getJobRunById` depuis `../jobRuns.js` (ajouter au bloc d'import existant).
2. Ajouter `db: Database` en dernier paramètre de `triggerPlan`, `triggerRecomputePlan`, `triggerRetry`, `resumeAfterPlanInterrupt` et `awaitGoAndResume`, et propager `db` à chaque appel interne de `resumeAfterPlanInterrupt(rule, job, graph, telegram, config, db)` (4 sites : `triggerPlan`, `triggerRecomputePlan`, `triggerRetry`, `recoverPendingGoWaits`).
3. Dans `triggerCronDecision`, les deux appels deviennent `await triggerPlan(rule, job, graph, telegram, db);`.
4. Remplacer `awaitGoAndResume` par :

```ts
async function awaitGoAndResume(
  rule: BookingRule,
  job: JobRun,
  graph: PipelineGraph,
  telegram: TelegramConfig,
  config: RunnableGraphConfig,
  db: Database,
): Promise<void> {
  const confirmed = await waitForGoConfirmation(telegram, { timeoutMs: GO_WAIT_TIMEOUT_MS });
  // Garde-fou (spec 2026-09-12) : le job a pu être annulé pendant le long-polling
  // (fermeture PUC déclarée après coup, annulation manuelle). Reprendre le graphe
  // relancerait Announce — et la réservation réelle — d'un job arrêté.
  const fresh = await getJobRunById(db, rule.id, job.id);
  if (fresh?.cancelledAt) {
    await sendTelegramMessage(
      telegram,
      `[${rule.id}] "go" ignoré — job du ${job.targetDate} annulé (${fresh.cancelReason ?? "annulation manuelle"}).`,
    );
    return;
  }
  try {
    await graph.invoke(new Command({ resume: resumeValueForTelegramGo(job, confirmed) }), config);
  } catch (err) {
    await sendTelegramMessage(telegram, `[${rule.id}] Erreur Announce : ${(err as Error).message}`);
  }
}
```

5. Dans `apps/worker/src/http/server.ts` (handler trigger, lignes ~380-384) : `triggerPlan(rule, job, deps.graph, deps.telegram, deps.db)`, `triggerRecomputePlan(rule, job, deps.graph, deps.telegram, deps.db)`, `triggerRetry(rule, job, deps.graph, deps.telegram, deps.db)`.

- [ ] **Step 4: Tests verts + typecheck**

Run: `cd apps/worker && npx vitest run src/scheduler/scheduler.test.ts && cd ../.. && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/scheduler/scheduler.ts apps/worker/src/scheduler/scheduler.test.ts apps/worker/src/http/server.ts
git commit -m "fix(scheduler): ignorer un go Telegram reçu après annulation du job"
```

---

### Task 7: Routes worker `POST /club-closures/preview` et `POST /club-closures`

**Files:**
- Create: `apps/worker/src/http/clubClosuresHandlers.ts`
- Test: `apps/worker/src/http/clubClosuresHandlers.test.ts`
- Modify: `apps/worker/src/http/server.ts` (constantes de routes + branchement dans `handleRequest`)

**Interfaces:**
- Consumes: `loadClosureImpact` (Task 4), `cancelJobForClosure` (Task 5), `getBookingRuleById`, `getJobRunById`, table `clubClosures`.
- Produces:

```ts
export interface ClosureIntervalInput { startsAt: string; endsAt: string }
export function parseClosureInterval(body: Record<string, unknown>): { ok: true; interval: ClosureInterval } | { ok: false; error: string }
export function handleClubClosurePreview(res, deps: HttpServerDeps, body): Promise<void>   // 200 ClosureImpact | 400
export function handleClubClosureCreate(res, deps: HttpServerDeps, body): Promise<void>    // 200 CreateClosureResponse | 400
export interface CreateClosureResponse {
  closureId: string;
  cancelled: ClosureImpactEntry[];
  failed: Array<{ jobId: string; ruleId: string; error: string }>;
  planned: ClosureImpactEntry[];
  errored: ClosureImpactEntry[];
}
```

- [ ] **Step 1: Tests (RED)**

Créer `apps/worker/src/http/clubClosuresHandlers.test.ts` :

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";

vi.mock("../closures/loadClosureImpact.js", () => ({ loadClosureImpact: vi.fn() }));
vi.mock("../closures/cancelJobForClosure.js", () => ({ cancelJobForClosure: vi.fn() }));
vi.mock("../bookingRules.js", () => ({ getBookingRuleById: vi.fn() }));
vi.mock("../jobRuns.js", () => ({ getJobRunById: vi.fn() }));

const { loadClosureImpact } = await import("../closures/loadClosureImpact.js");
const { cancelJobForClosure } = await import("../closures/cancelJobForClosure.js");
const { getBookingRuleById } = await import("../bookingRules.js");
const { getJobRunById } = await import("../jobRuns.js");
const { handleClubClosureCreate, handleClubClosurePreview, parseClosureInterval } = await import("./clubClosuresHandlers.js");

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, writeHead: vi.fn(), end: vi.fn() };
  res.writeHead.mockImplementation((code: number) => { res.statusCode = code; });
  res.end.mockImplementation((raw: string) => { res.body = JSON.parse(raw); });
  return res as unknown as ServerResponse & { statusCode: number; body: unknown };
}

function deps(insertedId = "closure-1") {
  const insert = vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => [{ id: insertedId }]) })) }));
  return { db: { insert } as never, graph: {} as never, telegram: { botToken: "t", chatId: "c" }, huddleBot: { client: {} as never, close: async () => {} }, resaSquash: { client: {} as never, close: async () => {} }, insert };
}

const runningEntry = { ruleId: "rule-sam", ruleLabel: "Samedi", jobId: "job-1", targetDate: "2026-09-19", stage: "awaiting-decision" as const, closedTimes: ["18H45"] };
const validBody = { startsAt: "2026-09-18T22:00:00.000Z", endsAt: "2026-09-19T22:00:00.000Z", label: "tournoi" };

describe("parseClosureInterval", () => {
  it("refuse endsAt <= startsAt", () => {
    expect(parseClosureInterval({ startsAt: validBody.endsAt, endsAt: validBody.startsAt })).toEqual({ ok: false, error: "La fin doit être après le début." });
  });
  it("refuse une date invalide", () => {
    expect(parseClosureInterval({ startsAt: "nope", endsAt: validBody.endsAt }).ok).toBe(false);
  });
});

describe("handleClubClosurePreview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renvoie l'impact sans rien écrire", async () => {
    vi.mocked(loadClosureImpact).mockResolvedValue({ running: [runningEntry], planned: [], errored: [] });
    const res = fakeRes();
    const d = deps();

    await handleClubClosurePreview(res, d, validBody);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ running: [runningEntry], planned: [], errored: [] });
    expect(d.insert).not.toHaveBeenCalled();
    expect(cancelJobForClosure).not.toHaveBeenCalled();
  });

  it("400 sur bornes invalides", async () => {
    const res = fakeRes();
    await handleClubClosurePreview(res, deps(), { startsAt: "x", endsAt: "y" });
    expect(res.statusCode).toBe(400);
  });
});

describe("handleClubClosureCreate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("400 si libellé vide, rien n'est inséré", async () => {
    const res = fakeRes();
    const d = deps();
    await handleClubClosureCreate(res, d, { ...validBody, label: "  " });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Le libellé (raison de la fermeture) est obligatoire." });
    expect(d.insert).not.toHaveBeenCalled();
  });

  it("insère, recalcule l'impact et arrête chaque job en cours", async () => {
    vi.mocked(loadClosureImpact).mockResolvedValue({ running: [runningEntry], planned: [], errored: [] });
    vi.mocked(getBookingRuleById).mockResolvedValue({ id: "rule-sam" } as never);
    vi.mocked(getJobRunById).mockResolvedValue({ id: "job-1" } as never);
    vi.mocked(cancelJobForClosure).mockResolvedValue({ ok: true, jobId: "job-1", pollDeleted: true });
    const res = fakeRes();
    const d = deps();

    await handleClubClosureCreate(res, d, validBody);

    expect(d.insert).toHaveBeenCalledTimes(1);
    expect(cancelJobForClosure).toHaveBeenCalledWith(
      expect.objectContaining({ db: d.db }),
      { id: "rule-sam" },
      { id: "job-1" },
      runningEntry,
      { id: "closure-1", label: "tournoi" },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ closureId: "closure-1", cancelled: [runningEntry], failed: [], planned: [], errored: [] });
  });

  it("un échec de cascade n'empêche pas les autres et remonte dans failed", async () => {
    const second = { ...runningEntry, jobId: "job-2", ruleId: "rule-dim" };
    vi.mocked(loadClosureImpact).mockResolvedValue({ running: [runningEntry, second], planned: [], errored: [] });
    vi.mocked(getBookingRuleById).mockImplementation(async (_db, id) => ({ id }) as never);
    vi.mocked(getJobRunById).mockImplementation(async (_db, _ruleId, id) => ({ id }) as never);
    vi.mocked(cancelJobForClosure)
      .mockResolvedValueOnce({ ok: false, jobId: "job-1", error: "whatsapp down", pollDeleted: true })
      .mockResolvedValueOnce({ ok: true, jobId: "job-2", pollDeleted: true });
    const res = fakeRes();

    await handleClubClosureCreate(res, deps(), validBody);

    expect(res.body).toEqual({
      closureId: "closure-1",
      cancelled: [second],
      failed: [{ jobId: "job-1", ruleId: "rule-sam", error: "whatsapp down" }],
      planned: [],
      errored: [],
    });
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `cd apps/worker && npx vitest run src/http/clubClosuresHandlers.test.ts` → FAIL (module introuvable).

- [ ] **Step 3: Implémenter les handlers**

Créer `apps/worker/src/http/clubClosuresHandlers.ts` :

```ts
import type { ServerResponse } from "node:http";
import { clubClosures } from "@squash-assistant/db/schema";
import { getBookingRuleById } from "../bookingRules.js";
import { cancelJobForClosure } from "../closures/cancelJobForClosure.js";
import type { ClosureImpactEntry } from "../closures/closureImpact.js";
import type { ClosureInterval } from "../closures/filterCandidateTimes.js";
import { loadClosureImpact } from "../closures/loadClosureImpact.js";
import { getJobRunById } from "../jobRuns.js";
import type { HttpServerDeps } from "./server.js";

export interface CreateClosureResponse {
  closureId: string;
  cancelled: ClosureImpactEntry[];
  failed: Array<{ jobId: string; ruleId: string; error: string }>;
  planned: ClosureImpactEntry[];
  errored: ClosureImpactEntry[];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseDate(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseClosureInterval(
  body: Record<string, unknown>,
): { ok: true; interval: ClosureInterval } | { ok: false; error: string } {
  const startsAt = parseDate(body.startsAt);
  const endsAt = parseDate(body.endsAt);
  if (!startsAt || !endsAt) return { ok: false, error: "Dates de début/fin invalides (ISO 8601 attendu)." };
  if (endsAt.getTime() <= startsAt.getTime()) return { ok: false, error: "La fin doit être après le début." };
  return { ok: true, interval: { startsAt, endsAt } };
}

/** Lecture seule : impact d'une fermeture hypothétique sur les jobs en cours / prévus. */
export async function handleClubClosurePreview(
  res: ServerResponse,
  deps: HttpServerDeps,
  body: Record<string, unknown>,
): Promise<void> {
  const parsed = parseClosureInterval(body);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  try {
    sendJson(res, 200, await loadClosureImpact(deps, parsed.interval));
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Crée la fermeture puis arrête tout job en cours impacté — l'impact est recalculé ICI, au
 * moment de la confirmation, pas repris de l'aperçu (spec 2026-09-12). L'échec d'un job
 * n'arrête pas les autres.
 */
export async function handleClubClosureCreate(
  res: ServerResponse,
  deps: HttpServerDeps,
  body: Record<string, unknown>,
): Promise<void> {
  const parsed = parseClosureInterval(body);
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error });
    return;
  }
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) {
    sendJson(res, 400, { error: "Le libellé (raison de la fermeture) est obligatoire." });
    return;
  }

  try {
    const [inserted] = await deps.db
      .insert(clubClosures)
      .values({ startsAt: parsed.interval.startsAt, endsAt: parsed.interval.endsAt, label })
      .returning();
    const closure = { id: inserted!.id, label };
    const impact = await loadClosureImpact(deps, { ...parsed.interval, label });

    const cancelled: ClosureImpactEntry[] = [];
    const failed: CreateClosureResponse["failed"] = [];
    for (const entry of impact.running) {
      if (!entry.jobId) continue;
      const rule = await getBookingRuleById(deps.db, entry.ruleId);
      const job = await getJobRunById(deps.db, entry.ruleId, entry.jobId);
      if (!rule || !job) {
        failed.push({ jobId: entry.jobId, ruleId: entry.ruleId, error: "Règle ou job introuvable." });
        continue;
      }
      const result = await cancelJobForClosure(deps, rule, job, entry, closure);
      if (result.ok) cancelled.push(entry);
      else failed.push({ jobId: entry.jobId, ruleId: entry.ruleId, error: result.error });
    }

    const response: CreateClosureResponse = {
      closureId: closure.id,
      cancelled,
      failed,
      planned: impact.planned,
      errored: impact.errored,
    };
    sendJson(res, 200, response);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
```

`HttpServerDeps` contient déjà `huddleBot`, `resaSquash`, `telegram`, `db` : il est structurellement compatible avec `GraphDependencies` attendu par `cancelJobForClosure`.

- [ ] **Step 4: Brancher les routes**

Dans `apps/worker/src/http/server.ts` :

1. Import : `import { handleClubClosureCreate, handleClubClosurePreview } from "./clubClosuresHandlers.js";`
2. Constantes, après `SCHEDULER_RELOAD_ROUTE` :

```ts
const CLUB_CLOSURES_ROUTE = "/club-closures";
const CLUB_CLOSURES_PREVIEW_ROUTE = "/club-closures/preview";
```

3. Dans `handleRequest`, juste après le bloc `SCHEDULER_RELOAD_ROUTE` :

```ts
  if (req.method === "POST" && url.pathname === CLUB_CLOSURES_PREVIEW_ROUTE) {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
      return;
    }
    await handleClubClosurePreview(res, deps, body);
    return;
  }

  if (req.method === "POST" && url.pathname === CLUB_CLOSURES_ROUTE) {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
      return;
    }
    await handleClubClosureCreate(res, deps, body);
    return;
  }
```

- [ ] **Step 5: Tests verts, typecheck, commit**

Run: `npm run worker:test && npm run typecheck` → PASS.

```bash
git add apps/worker/src/http/clubClosuresHandlers.ts apps/worker/src/http/clubClosuresHandlers.test.ts apps/worker/src/http/server.ts
git commit -m "feat(http): routes fermeture PUC — aperçu d'impact et création avec cascade"
```

---

### Task 8: UI — client worker, libellés d'affichage, server actions

**Files:**
- Modify: `apps/ui/src/lib/worker.ts`
- Create: `apps/ui/src/lib/closureImpactLabels.ts`
- Test: `apps/ui/src/lib/closureImpactLabels.test.ts`
- Modify: `apps/ui/src/lib/clubClosures.ts` (retirer `createClubClosure`) + `clubClosures.test.ts` si un test le couvre
- Modify: `apps/ui/src/app/actions.ts`

**Interfaces:**
- Produces (worker.ts) :

```ts
export interface ClosureImpactEntry { ruleId: string; ruleLabel: string; jobId: string | null; targetDate: string; stage: PipelineStage | "not-created"; closedTimes: string[] }
export interface ClosureImpact { running: ClosureImpactEntry[]; planned: ClosureImpactEntry[]; errored: ClosureImpactEntry[] }
export interface CreateClosureResponse { closureId: string; cancelled: ClosureImpactEntry[]; failed: Array<{ jobId: string; ruleId: string; error: string }>; planned: ClosureImpactEntry[]; errored: ClosureImpactEntry[] }
export function previewClubClosure(startsAt: Date, endsAt: Date): Promise<ClosureImpact>
export function createClubClosureWithCascade(startsAt: Date, endsAt: Date, label: string): Promise<CreateClosureResponse>
```

- Produces (closureImpactLabels.ts) : `stageLabel(stage)`, `formatClosedTimes(times)`, `impactSummary(impact)`.
- Produces (actions.ts) :

```ts
export interface ClosureFormInput { allDay: boolean; startDate?: string; endDate?: string; startsAt?: string; endsAt?: string; label: string }
export async function previewClubClosureAction(input: ClosureFormInput): Promise<ClosureImpact>
export async function confirmClubClosureAction(input: ClosureFormInput): Promise<CreateClosureResponse>
```

- [ ] **Step 1: Test des libellés (RED)**

Créer `apps/ui/src/lib/closureImpactLabels.test.ts` :

```ts
import { describe, expect, it } from "vitest";
import { formatClosedTimes, impactSummary, stageLabel } from "./closureImpactLabels";

describe("stageLabel", () => {
  it("traduit les étapes en français", () => {
    expect(stageLabel("awaiting-decision")).toBe("sondage en cours");
    expect(stageLabel("awaiting-plan")).toBe("votes figés, plan à calculer");
    expect(stageLabel("awaiting-go")).toBe("plan calculé, en attente du go");
    expect(stageLabel("not-started")).toBe("pas encore démarré");
    expect(stageLabel("not-created")).toBe("sondage à venir");
    expect(stageLabel("error")).toBe("en erreur");
  });
});

describe("formatClosedTimes", () => {
  it("18H45 → 18h45, 19H00 → 19h", () => {
    expect(formatClosedTimes(["18H45", "19H00"])).toBe("18h45, 19h");
  });
});

describe("impactSummary", () => {
  it("aucun impact", () => {
    expect(impactSummary({ running: [], planned: [], errored: [] })).toBe("Aucun job concerné.");
  });
  it("compte les jobs arrêtés et prévus", () => {
    const e = { ruleId: "r", ruleLabel: "Samedi", jobId: "j", targetDate: "2026-09-19", stage: "awaiting-decision" as const, closedTimes: ["18H45"] };
    expect(impactSummary({ running: [e], planned: [e, e], errored: [] })).toBe("1 job en cours sera arrêté, 2 jobs prévus recevront le message de fermeture.");
  });
});
```

Run: `cd apps/ui && npx vitest run src/lib/closureImpactLabels.test.ts` → FAIL.

- [ ] **Step 2: Types + client worker**

Dans `apps/ui/src/lib/worker.ts`, après `cancelPoll` :

```ts
/** Miroir de `ClosureImpactEntry` côté worker (apps/worker/src/closures/closureImpact.ts). */
export interface ClosureImpactEntry {
  ruleId: string;
  ruleLabel: string;
  jobId: string | null;
  targetDate: string;
  stage: PipelineStage | "not-created";
  closedTimes: string[];
}

export interface ClosureImpact {
  running: ClosureImpactEntry[];
  planned: ClosureImpactEntry[];
  errored: ClosureImpactEntry[];
}

export interface CreateClosureResponse {
  closureId: string;
  cancelled: ClosureImpactEntry[];
  failed: Array<{ jobId: string; ruleId: string; error: string }>;
  planned: ClosureImpactEntry[];
  errored: ClosureImpactEntry[];
}

/** Aperçu (lecture seule) des jobs impactés par une fermeture PUC — spec 2026-09-12. */
export function previewClubClosure(startsAt: Date, endsAt: Date): Promise<ClosureImpact> {
  return callWorker("/club-closures/preview", "POST", {
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  }) as Promise<ClosureImpact>;
}

/** Crée la fermeture et arrête les jobs en cours impactés (sondage supprimé + message WhatsApp). */
export function createClubClosureWithCascade(startsAt: Date, endsAt: Date, label: string): Promise<CreateClosureResponse> {
  return callWorker("/club-closures", "POST", {
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    label,
  }) as Promise<CreateClosureResponse>;
}
```

- [ ] **Step 3: Libellés d'affichage**

Créer `apps/ui/src/lib/closureImpactLabels.ts` :

```ts
import type { ClosureImpact, ClosureImpactEntry } from "./worker";

const STAGE_LABELS: Record<ClosureImpactEntry["stage"], string> = {
  "not-started": "pas encore démarré",
  "not-created": "sondage à venir",
  "awaiting-decision": "sondage en cours",
  "awaiting-plan": "votes figés, plan à calculer",
  "awaiting-go": "plan calculé, en attente du go",
  error: "en erreur",
  "finished-club-closed": "terminé (PUC fermé)",
  "finished-no-plan": "terminé (pas de plan)",
  "finished-announced": "terminé (annoncé)",
  "finished-cancelled": "terminé (pas de go)",
};

export function stageLabel(stage: ClosureImpactEntry["stage"]): string {
  return STAGE_LABELS[stage] ?? stage;
}

/** "18H45" → "18h45", "19H00" → "19h". */
export function formatClosedTimes(times: string[]): string {
  return times
    .map((t) => {
      const m = /^(\d{1,2})H(\d{2})$/i.exec(t);
      if (!m) return t;
      return m[2] === "00" ? `${m[1]}h` : `${m[1]}h${m[2]}`;
    })
    .join(", ");
}

function plural(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n > 1 ? pluralForm : singular}`;
}

export function impactSummary(impact: ClosureImpact): string {
  if (impact.running.length === 0 && impact.planned.length === 0 && impact.errored.length === 0) {
    return "Aucun job concerné.";
  }
  const parts: string[] = [];
  if (impact.running.length > 0) {
    parts.push(`${plural(impact.running.length, "job en cours sera arrêté", "jobs en cours seront arrêtés")}`);
  }
  if (impact.planned.length > 0) {
    parts.push(
      `${plural(impact.planned.length, "job prévu recevra le message de fermeture", "jobs prévus recevront le message de fermeture")}`,
    );
  }
  if (impact.errored.length > 0) {
    parts.push(`${plural(impact.errored.length, "job en erreur à annuler à la main", "jobs en erreur à annuler à la main")}`);
  }
  return `${parts.join(", ")}.`;
}
```

Run: `cd apps/ui && npx vitest run src/lib/closureImpactLabels.test.ts` → PASS.

- [ ] **Step 4: Server actions**

Dans `apps/ui/src/app/actions.ts` :

1. Dans l'import de `../lib/clubClosures`, retirer `createClubClosure` (garder `deleteClubClosure`, `parisLocalInputToDate`, `parisWholeDaysToInterval`).
2. Dans l'import de `../lib/worker`, ajouter `createClubClosureWithCascade`, `previewClubClosure`, `type ClosureImpact`, `type CreateClosureResponse`.
3. **Remplacer** `addClubClosureAction` par :

```ts
export interface ClosureFormInput {
  allDay: boolean;
  /** Mode journée entière : dates civiles Paris (YYYY-MM-DD), `endDate` optionnelle = `startDate`. */
  startDate?: string;
  endDate?: string;
  /** Mode horaires précis : datetime-local "YYYY-MM-DDTHH:mm" interprété Europe/Paris. */
  startsAt?: string;
  endsAt?: string;
  label: string;
}

function closureIntervalFromInput(input: ClosureFormInput): { startsAt: Date; endsAt: Date } {
  if (input.allDay) {
    const startDate = (input.startDate ?? "").trim();
    const endDate = (input.endDate ?? "").trim() || startDate;
    return parisWholeDaysToInterval(startDate, endDate);
  }
  return {
    startsAt: parisLocalInputToDate(input.startsAt ?? ""),
    endsAt: parisLocalInputToDate(input.endsAt ?? ""),
  };
}

/** Étape 1 du formulaire de fermeture : aperçu des jobs impactés (lecture seule, rien n'est enregistré). */
export async function previewClubClosureAction(input: ClosureFormInput): Promise<ClosureImpact> {
  await requireAdmin();
  const { startsAt, endsAt } = closureIntervalFromInput(input);
  return previewClubClosure(startsAt, endsAt);
}

/** Étape 2 : création de la fermeture + arrêt des jobs en cours impactés (worker). */
export async function confirmClubClosureAction(input: ClosureFormInput): Promise<CreateClosureResponse> {
  await requireAdmin();
  const label = input.label.trim();
  if (!label) throw new Error("Le libellé (raison de la fermeture) est obligatoire.");
  const { startsAt, endsAt } = closureIntervalFromInput(input);
  const result = await createClubClosureWithCascade(startsAt, endsAt, label);
  revalidatePath("/settings");
  for (const entry of result.cancelled) {
    if (entry.jobId) revalidatePath(`/rules/${entry.ruleId}/jobs/${entry.jobId}`);
    revalidatePath(`/rules/${entry.ruleId}/events`);
  }
  return result;
}
```

4. Dans `apps/ui/src/lib/clubClosures.ts`, supprimer la fonction `createClubClosure` (et son test dans `clubClosures.test.ts` s'il existe — vérifier avec `grep -n createClubClosure apps/ui/src/lib/clubClosures.test.ts`).

- [ ] **Step 5: Typecheck UI (le composant et la page ne compilent plus tant que `addClubClosureAction` est référencé — c'est attendu, Task 9 corrige)**

Run: `cd apps/ui && npx vitest run` → PASS. Ne pas lancer le typecheck global avant Task 9.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/lib/worker.ts apps/ui/src/lib/closureImpactLabels.ts apps/ui/src/lib/closureImpactLabels.test.ts apps/ui/src/lib/clubClosures.ts apps/ui/src/lib/clubClosures.test.ts apps/ui/src/app/actions.ts
git commit -m "feat(ui): actions aperçu/confirmation de fermeture PUC via le worker"
```

---

### Task 9: UI — formulaire deux temps et page `/settings`

**Files:**
- Rewrite: `apps/ui/src/app/components/ClubClosureAddForm.tsx`
- Modify: `apps/ui/src/app/settings/page.tsx`

**Interfaces:**
- Consumes: `previewClubClosureAction`, `confirmClubClosureAction`, `ClosureFormInput` (Task 8), `stageLabel`, `formatClosedTimes`, `impactSummary` (Task 8), `useRouter` (Next.js) pour rafraîchir la liste après confirmation.

- [ ] **Step 1: Réécrire le composant**

Remplacer intégralement `apps/ui/src/app/components/ClubClosureAddForm.tsx` :

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ClosureFormInput } from "../actions";
import { formatClosedTimes, impactSummary, stageLabel } from "../../lib/closureImpactLabels";
import type { ClosureImpact, ClosureImpactEntry, CreateClosureResponse } from "../../lib/worker";

type Props = {
  previewAction: (input: ClosureFormInput) => Promise<ClosureImpact>;
  confirmAction: (input: ClosureFormInput) => Promise<CreateClosureResponse>;
  disabled?: boolean;
};

type Phase = { kind: "edit" } | { kind: "preview"; impact: ClosureImpact } | { kind: "done"; result: CreateClosureResponse };

const EMPTY: ClosureFormInput = { allDay: true, startDate: "", endDate: "", startsAt: "", endsAt: "", label: "" };

function ImpactTable({ title, entries, note }: { title: string; entries: ClosureImpactEntry[]; note: string }) {
  if (entries.length === 0) return null;
  return (
    <>
      <h4 style={{ margin: "0.75rem 0 0.25rem" }}>{title}</h4>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>{note}</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Groupe / règle</th>
              <th>Date cible</th>
              <th>Étape</th>
              <th>Heures fermées</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={`${e.ruleId}:${e.jobId ?? e.targetDate}`}>
                <td>{e.ruleLabel}</td>
                <td>{e.targetDate}</td>
                <td>{stageLabel(e.stage)}</td>
                <td>{formatClosedTimes(e.closedTimes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Formulaire de fermeture PUC en deux temps (spec 2026-09-12) : saisie → aperçu des jobs
 * impactés → confirmation. Rien n'est enregistré avant « Confirmer la fermeture ».
 * État contrôlé (comme GoConfirmationForm) : la saisie survit à l'aller-retour aperçu ↔ édition.
 */
export function ClubClosureAddForm({ previewAction, confirmAction, disabled = false }: Props) {
  const router = useRouter();
  const [input, setInput] = useState<ClosureFormInput>(EMPTY);
  const [phase, setPhase] = useState<Phase>({ kind: "edit" });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const update = (patch: Partial<ClosureFormInput>) => setInput((prev) => ({ ...prev, ...patch }));

  const onPreview = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        setPhase({ kind: "preview", impact: await previewAction(input) });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await confirmAction(input);
        setPhase({ kind: "done", result });
        setInput(EMPTY);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  if (phase.kind === "done") {
    const { result } = phase;
    return (
      <div style={{ marginTop: "1rem" }}>
        <p>✓ Fermeture enregistrée.</p>
        {result.cancelled.length > 0 && (
          <p>
            {result.cancelled.length} job(s) arrêté(s) : {result.cancelled.map((c) => `${c.ruleLabel} (${c.targetDate})`).join(", ")} — sondage supprimé et groupe prévenu.
          </p>
        )}
        {result.failed.length > 0 && (
          <p className="badge-off">
            Échecs : {result.failed.map((f) => `${f.ruleId}/${f.jobId} — ${f.error}`).join(" ; ")}
          </p>
        )}
        <button type="button" onClick={() => setPhase({ kind: "edit" })}>Ajouter une autre fermeture</button>
      </div>
    );
  }

  return (
    <form onSubmit={onPreview}>
      <fieldset disabled={disabled || pending || phase.kind === "preview"} style={{ border: 0, padding: 0, margin: "1rem 0 0" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <input type="checkbox" checked={input.allDay} onChange={(e) => update({ allDay: e.target.checked })} />
          Toute la journée
          <span className="muted">(une ou plusieurs dates civiles, sans choisir l&apos;heure)</span>
        </label>

        <div className="form-grid">
          {input.allDay ? (
            <>
              <label>
                Du
                <input type="date" required value={input.startDate} onChange={(e) => update({ startDate: e.target.value })} />
              </label>
              <label>
                Au
                <input type="date" required value={input.endDate} onChange={(e) => update({ endDate: e.target.value })} />
              </label>
            </>
          ) : (
            <>
              <label>
                Début
                <input type="datetime-local" required value={input.startsAt} onChange={(e) => update({ startsAt: e.target.value })} />
              </label>
              <label>
                Fin
                <input type="datetime-local" required value={input.endsAt} onChange={(e) => update({ endsAt: e.target.value })} />
              </label>
            </>
          )}
          <label>
            Libellé (raison, obligatoire)
            <input type="text" required placeholder="tournoi, travaux, 15 août…" value={input.label} onChange={(e) => update({ label: e.target.value })} />
          </label>
        </div>
      </fieldset>

      {error && <p className="badge-off" style={{ marginTop: "0.5rem" }}>{error}</p>}

      {phase.kind === "edit" ? (
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={disabled || pending}>
            {pending && <span className="spinner" aria-hidden="true" />}
            Vérifier l&apos;impact
          </button>
        </div>
      ) : (
        <div style={{ marginTop: "1rem" }}>
          <p><strong>{impactSummary(phase.impact)}</strong></p>
          <ImpactTable
            title="Jobs en cours — seront arrêtés"
            entries={phase.impact.running}
            note="Le sondage WhatsApp sera supprimé et le groupe prévenu (message avec la raison)."
          />
          <ImpactTable
            title="Jobs prévus"
            entries={phase.impact.planned}
            note="Recevront le message de fermeture à la place du sondage."
          />
          <ImpactTable
            title="Jobs en erreur"
            entries={phase.impact.errored}
            note="À annuler à la main depuis la page du job — aucune action automatique."
          />
          <div className="form-actions">
            <button type="button" onClick={() => setPhase({ kind: "edit" })} disabled={pending}>Annuler</button>
            <button
              type="button"
              className={phase.impact.running.length > 0 ? "button-danger" : "button-primary"}
              onClick={onConfirm}
              disabled={pending}
            >
              {pending && <span className="spinner" aria-hidden="true" />}
              Confirmer la fermeture
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
```

Vérifier qu'une classe `button-danger` existe dans `apps/ui/src/app/globals.css` (`grep -n "button-danger" apps/ui/src/app/*.css`). Si absente, ajouter :

```css
.button-danger { background: #b42318; color: #fff; border-color: #b42318; }
.button-danger:hover { background: #912018; }
```

- [ ] **Step 2: Brancher dans la page**

Dans `apps/ui/src/app/settings/page.tsx` :

1. Import des actions : remplacer `addClubClosureAction,` par `confirmClubClosureAction, previewClubClosureAction,`.
2. Remplacer `<ClubClosureAddForm action={addClubClosureAction} disabled={!admin} />` par :

```tsx
      <ClubClosureAddForm previewAction={previewClubClosureAction} confirmAction={confirmClubClosureAction} disabled={!admin} />
```

3. Sous le `<p className="muted">Intervalles pendant lesquels…</p>`, ajouter :

```tsx
      <p className="muted">
        Une fermeture qui couvre une heure candidate d&apos;un job en cours arrête ce job : sondage WhatsApp supprimé, groupe prévenu. Un aperçu est affiché avant confirmation.
      </p>
```

- [ ] **Step 3: Typecheck + tests UI**

Run: `npm run typecheck && npm test -w @squash-assistant/ui`
Expected: PASS.

- [ ] **Step 4: Vérification manuelle (dev)**

Run: `npm run worker:dev` et `npm run ui:dev` (Postgres + Redis docker-compose démarrés). Sur `/settings` : saisir une fermeture journée entière sur une date cible d'une règle avec un job en cours → l'aperçu liste le job ; « Annuler » revient à la saisie avec les valeurs conservées ; « Confirmer » affiche le récapitulatif, la fermeture apparaît dans la liste, la page du job affiche l'annulation. Noter tout écart.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/app/components/ClubClosureAddForm.tsx apps/ui/src/app/settings/page.tsx apps/ui/src/app/globals.css
git commit -m "feat(ui): formulaire de fermeture PUC en deux temps (aperçu, confirmation)"
```

---

### Task 10: Page du job — afficher la cause d'annulation

**Files:**
- Modify: `apps/ui/src/app/rules/[id]/jobs/[jobId]/Pipeline.tsx:226-228`
- Modify: `apps/ui/src/app/rules/[id]/events/page.tsx:90-91`

- [ ] **Step 1: Pipeline**

Remplacer le bloc :

```tsx
  if (job.cancelledAt) {
    return <p className="muted">✗ Job annulé le {formatDateTimeParis(job.cancelledAt)} (sondage supprimé).</p>;
  }
```

par :

```tsx
  if (job.cancelledAt) {
    return (
      <p className="muted">
        ✗ Job annulé le {formatDateTimeParis(job.cancelledAt)}
        {job.cancelReason ? ` — ${job.cancelReason} (sondage supprimé, groupe prévenu)` : " (sondage supprimé)"}.
      </p>
    );
  }
```

- [ ] **Step 2: Historique des jobs**

Dans `events/page.tsx`, remplacer `{job.cancelledAt ? "annulé" : (STAGE_LABELS[status.stage] ?? status.stage)}` par :

```tsx
                      {job.cancelledAt ? (job.cancelReason ? `annulé — ${job.cancelReason}` : "annulé") : (STAGE_LABELS[status.stage] ?? status.stage)}
```

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` → PASS.

```bash
git add "apps/ui/src/app/rules/[id]/jobs/[jobId]/Pipeline.tsx" "apps/ui/src/app/rules/[id]/events/page.tsx"
git commit -m "feat(ui): afficher la cause d'annulation d'un job (PUC fermé)"
```

---

### Task 11: Spec fonctionnelle, graphify, vérification finale

**Files:**
- Modify: `docs/spec/regles-fonctionnelles.md` (section « Fermetures PUC (2026-08-09) », lignes ~43-46)

- [ ] **Step 1: Mettre à jour la règle**

Remplacer la ligne `- une fermeture ajoutée **après** l'envoi du sondage ne recalcule pas le job en cours.` par :

```markdown
  - **Fermeture déclarée tardivement (2026-09-12)** : ajouter une fermeture dans `/settings` se fait en deux temps — **aperçu** des jobs impactés (en cours / prévus / en erreur), puis **confirmation explicite**. Rien n'est enregistré avant la confirmation.
    - **Job en cours impacté** = job non annulé, sondage envoyé, non terminé (`awaiting-decision`, `awaiting-plan`, `awaiting-go`) dont **au moins une** heure candidate tombe dans l'intervalle — une fermeture partielle couvrant une heure candidate arrête le job **autant** qu'une journée entière.
    - À la confirmation, pour chaque job en cours impacté (impact recalculé à ce moment-là, pas repris de l'aperçu) : suppression du sondage WhatsApp (`delete_message`, best effort), message WhatsApp informel avec la raison (`Hello la team ! Mauvaise nouvelle : le PUC est fermé samedi 19 septembre (tournoi), donc pas de squash ce jour-là 😕 J'ai supprimé le sondage, on remet ça la semaine prochaine 💪` — variante `Ignorez le sondage du coup` si le sondage n'a pas pu être supprimé), annulation du job (`cancelledAt`, `cancelReason = PUC fermé : <libellé>`, `clubClosureId`), événement `club-closed`, log Telegram. L'échec d'un job n'empêche pas les autres.
    - **Jamais touchés** : jobs terminés, jobs déjà annulés, **réservations TeamR** (soit le club n'est pas réservable, soit l'administrateur du PUC supprime lui-même les réservations). Un job en `error` couvert est listé dans l'aperçu « à annuler à la main », sans action automatique.
    - **Job prévu** (job `not-started` ou règle active dont un jour cible tombe dans l'intervalle) : listé pour information ; au SendPoll il recevra le message de fermeture à la place du sondage.
    - Le **libellé** de fermeture est **obligatoire** : il porte la raison dans les messages. Le message du SendPoll sur date déjà fermée devient : `Hello la team ! Le PUC est fermé samedi 19 septembre (tournoi), donc pas de squash ce jour-là 😕 Pas de sondage cette semaine, on remet ça la semaine suivante 💪` (parenthèse omise sans libellé ; plusieurs libellés joints par « / »).
    - Un « go » Telegram reçu **après** l'annulation d'un job est ignoré (log Telegram) — il ne relance jamais l'annonce ni la réservation.
    - Supprimer une fermeture ne réactive pas un job annulé.
```

Mettre aussi à jour, dans la même section, l'ancien texte `message WhatsApp \`puc fermé <jour> <date> pas de squash\`` → `message WhatsApp informel de fermeture avec la raison (voir ci-dessous)`.

Et la ligne 41 (`Une fois le sondage envoyé (awaiting-decision), il peut être annulé (cancelPollAction)…`) : ajouter à la fin ` ; `cancelReason` reste vide dans ce cas (annulation manuelle).`

- [ ] **Step 2: Graphify + vérification complète**

Run: `graphify update . && npm run typecheck && npm test`
Expected: PASS partout.

- [ ] **Step 3: Commit**

```bash
git add docs/spec/regles-fonctionnelles.md
git commit -m "docs(spec): règle fermeture PUC déclarée tardivement"
```

---

## Self-review (fait à la rédaction)

- **Couverture spec** : données (T1), messages (T2), détection pure + chargement (T3, T4), cascade (T5), garde-fou Telegram + 409 déjà générique dans `handleTrigger` (T6), routes (T7), UI deux temps + `cancelReason` (T8-T10), spec fonctionnelle (T11). Le non-objectif « sélection fine des jobs » est respecté : la route recalcule et arrête tout.
- **Placeholders** : aucun ; chaque étape code a son bloc.
- **Cohérence des types** : `ClosureInterval.label` (T2) consommé par T3/T5/T7 ; `cancelJobRun(db, jobId, { reason, clubClosureId })` identique T1/T5 ; `ClosureImpactEntry` identique worker (T3) / UI (T8) ; signatures `resumeAfterPlanInterrupt(..., config, db)` et `triggerPlan(..., db)` identiques T6 tests/impl/server.
- **Limite connue** : le composant client (T9) n'a pas de test automatisé (vitest UI n'inclut que `src/**/*.test.ts`) ; la vérification est manuelle (T9 Step 4), les helpers d'affichage sont testés (T8).
