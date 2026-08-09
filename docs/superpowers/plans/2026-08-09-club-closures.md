# Club Closures (fermetures PUC) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin gère des intervalles de fermeture PUC globaux ; SendPoll filtre les heures candidates, envoie un message WhatsApp et termine le job si aucune heure n’est jouable, sinon sondage partiel avec mention des heures fermées.

**Architecture:** Table `club_closures` (timestamptz). Fonction pure `filterCandidateTimesByClosures` (matching via `slotStartDateIsoHeuristicParis`). Nœud `sendPoll` branche A/B/C ; flag état `clubClosed` + arête conditionnelle vers `END` ; stage `finished-club-closed`. CRUD admin sur `/settings`.

**Tech Stack:** TypeScript, Drizzle/Postgres, LangGraph.js, Vitest, Next.js server actions, MCP huddle-bot `send_message` / `ask_poll`.

**Spec :** `docs/superpowers/specs/2026-08-09-club-closures-design.md`

## Global Constraints

- Timezone matching / saisie = **Europe/Paris** ; réutiliser `slotStartDateIsoHeuristicParis` (même heuristique DST que le planning).
- Fermetures **globales** (pas de FK `BookingRule`).
- Intervalle : `starts_at` inclus, `ends_at` **exclus** ; contrainte `ends_at > starts_at`.
- Message cas A (texte exact préfixe) : `puc fermé <jour> <date> pas de squash` (ex. `puc fermé mardi 15 août pas de squash`).
- Cas B : sondage uniquement sur `openTimes` ; mention fermées dans la question ; options Non + prête-nom inchangées.
- Stage terminal : `finished-club-closed` ; flag graphe `clubClosed: true` ; pas de `pollRequestId` en cas A.
- Event type DB/app : ajouter `"club-closed"` à `eventTypeValues` (colonne `events.type` est du `text` libre — pas de CHECK PG).
- Hors scope : fériés FR auto, recalcul post-sondage, fermetures par règle.
- Après chaque tâche worker/db : `npm run worker:test` / tests ciblés verts ; UI : typecheck si touchée.
- Mettre à jour `docs/spec/regles-fonctionnelles.md` dans la tâche UI/spec (même livrable fonctionnel).

---

## File Structure

| Fichier | Statut | Rôle |
|---------|--------|------|
| `packages/db/src/schema.ts` | Modifié | Table `clubClosures` + `eventTypeValues` + `"club-closed"` |
| `packages/db/src/migrations/0021_club_closures.sql` | Créé | Migration table |
| `apps/worker/src/closures/filterCandidateTimes.ts` | Créé | Partition open/closed (pur) |
| `apps/worker/src/closures/filterCandidateTimes.test.ts` | Créé | Tests matching |
| `apps/worker/src/closures/loadClubClosures.ts` | Créé | Charge intervalles depuis DB pour une `targetDate` |
| `apps/worker/src/graph/nodes/pollQuestion.ts` | Modifié | `buildClubClosedMessage` + `closedTimes` optionnel sur question |
| `apps/worker/src/graph/nodes/pollQuestion.test.ts` | Modifié | Tests textes |
| `apps/worker/src/graph/state.ts` | Modifié | `clubClosed` |
| `apps/worker/src/graph/buildGraph.ts` | Modifié | Arête conditionnelle SendPoll → END / waitForDecisionWindow |
| `apps/worker/src/graph/nodes/sendPoll.ts` | Modifié | Branche A/B/C |
| `apps/worker/src/scheduler/scheduler.ts` | Modifié | `computeStage` + `TERMINAL_STAGES` |
| `apps/ui/src/lib/worker.ts` | Modifié | Type `PipelineStage` |
| `apps/ui/src/app/rules/[id]/jobs/[jobId]/Pipeline.tsx` | Modifié | Affichage stage |
| `apps/ui/src/app/rules/[id]/events/page.tsx` | Modifié | Label stage / event |
| `apps/ui/src/lib/clubClosures.ts` | Créé | list / create / delete |
| `apps/ui/src/app/actions.ts` | Modifié | `addClubClosureAction` / `deleteClubClosureAction` |
| `apps/ui/src/app/settings/page.tsx` | Modifié | Section Fermetures PUC |
| `docs/spec/regles-fonctionnelles.md` | Modifié | Règle fonctionnelle |

---

### Task 1: Schéma DB `club_closures` + event type

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/migrations/0021_club_closures.sql` (via `npm run db:generate -w @squash-assistant/db` ou SQL manuel aligné journal)
- Modify: `packages/db/src/migrations/meta/_journal.json` (si generate)

**Interfaces:**
- Produces: table Drizzle `clubClosures` ; type `ClubClosure` ; `eventTypeValues` inclut `"club-closed"`

- [ ] **Step 1: Ajouter la table et l’event type dans `schema.ts`**

Après `appSettings` (ou avant `playerPreferences`), ajouter :

```ts
export const clubClosures = pgTable("club_closures", {
  id: uuid("id").primaryKey().defaultRandom(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ClubClosure = typeof clubClosures.$inferSelect;
```

Modifier :

```ts
export const eventTypeValues = ["poll", "collect_votes", "booking", "club-closed"] as const;
```

- [ ] **Step 2: Générer / écrire la migration**

```bash
npm run db:generate -w @squash-assistant/db
```

Si generate échoue ou produit trop, créer `packages/db/src/migrations/0021_club_closures.sql` :

```sql
CREATE TABLE "club_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

Et enregistrer l’entrée dans `meta/_journal.json` comme les migrations précédentes.

- [ ] **Step 3: Build db**

```bash
npm run db:build
```

Expected: OK

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/migrations/
git commit -m "feat(db): table club_closures + event type club-closed"
```

---

### Task 2: Filtre pur des heures candidates

**Files:**
- Create: `apps/worker/src/closures/filterCandidateTimes.ts`
- Create: `apps/worker/src/closures/filterCandidateTimes.test.ts`

**Interfaces:**
- Consumes: `slotStartDateIsoHeuristicParis` from `apps/worker/src/planning/teamrTime.ts`
- Produces:

```ts
export interface ClosureInterval {
  startsAt: Date;
  endsAt: Date;
}

export function filterCandidateTimesByClosures(
  targetDate: string,
  candidateStartTimes: string[],
  closures: ClosureInterval[],
): { openTimes: string[]; closedTimes: string[] };
```

- [ ] **Step 1: Écrire les tests (failing)**

```ts
import { describe, expect, it } from "vitest";
import { filterCandidateTimesByClosures } from "./filterCandidateTimes.js";

describe("filterCandidateTimesByClosures", () => {
  it("aucune fermeture → toutes ouvertes", () => {
    const r = filterCandidateTimesByClosures("2026-08-15", ["18H45", "19H30"], []);
    expect(r).toEqual({ openTimes: ["18H45", "19H30"], closedTimes: [] });
  });

  it("journée entière fermée → toutes fermées", () => {
    const r = filterCandidateTimesByClosures("2026-08-15", ["18H45", "19H30"], [
      { startsAt: new Date("2026-08-14T22:00:00.000Z"), endsAt: new Date("2026-08-15T22:00:00.000Z") }, // 15 août Paris (UTC+2 été)
    ]);
    expect(r.openTimes).toEqual([]);
    expect(r.closedTimes).toEqual(["18H45", "19H30"]);
  });

  it("fermeture partielle → partitionne", () => {
    // Ferme jusqu'à 19:00 Paris le 15/08/2026 → 18H45 fermé, 19H30 ouvert
    const r = filterCandidateTimesByClosures("2026-08-15", ["18H45", "19H30"], [
      { startsAt: new Date("2026-08-14T22:00:00.000Z"), endsAt: new Date("2026-08-15T17:00:00.000Z") }, // ends 19:00 Paris
    ]);
    expect(r.closedTimes).toEqual(["18H45"]);
    expect(r.openTimes).toEqual(["19H30"]);
  });

  it("borne ends_at exclusive : instant == endsAt → ouvert", () => {
    const endsAt = new Date("2026-08-15T16:45:00.000Z"); // 18:45 Paris
    const r = filterCandidateTimesByClosures("2026-08-15", ["18H45"], [
      { startsAt: new Date("2026-08-14T22:00:00.000Z"), endsAt },
    ]);
    expect(r.openTimes).toEqual(["18H45"]);
    expect(r.closedTimes).toEqual([]);
  });
});
```

Ajuster les instants UTC des fixtures si l’heuristique DST du helper donne un offset différent — le critère est : `startsAt <= instant < endsAt` avec `instant = new Date(slotStartDateIsoHeuristicParis(...))`.

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm run test -w @squash-assistant/worker -- src/closures/filterCandidateTimes.test.ts
```

Expected: FAIL (module missing)

- [ ] **Step 3: Implémentation minimale**

```ts
import { slotStartDateIsoHeuristicParis } from "../planning/teamrTime.js";

export interface ClosureInterval {
  startsAt: Date;
  endsAt: Date;
}

function isClosed(instant: Date, closures: ClosureInterval[]): boolean {
  const t = instant.getTime();
  return closures.some((c) => c.startsAt.getTime() <= t && t < c.endsAt.getTime());
}

export function filterCandidateTimesByClosures(
  targetDate: string,
  candidateStartTimes: string[],
  closures: ClosureInterval[],
): { openTimes: string[]; closedTimes: string[] } {
  const openTimes: string[] = [];
  const closedTimes: string[] = [];
  for (const time of candidateStartTimes) {
    const iso = slotStartDateIsoHeuristicParis(targetDate, time);
    if (iso == null) {
      openTimes.push(time);
      continue;
    }
    if (isClosed(new Date(iso), closures)) closedTimes.push(time);
    else openTimes.push(time);
  }
  return { openTimes, closedTimes };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm run test -w @squash-assistant/worker -- src/closures/filterCandidateTimes.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/closures/
git commit -m "feat(worker): filter candidate times against club closures"
```

---

### Task 3: Textes WhatsApp (message fermeture + question partielle)

**Files:**
- Modify: `apps/worker/src/graph/nodes/pollQuestion.ts`
- Modify: `apps/worker/src/graph/nodes/pollQuestion.test.ts`

**Interfaces:**
- Produces:

```ts
export function buildClubClosedMessage(targetDate: string): string;
export function buildPollQuestion(
  targetDate: string,
  candidateStartTimes: string[],
  closedTimes?: string[],
): string;
```

- [ ] **Step 1: Tests failing**

Ajouter dans `pollQuestion.test.ts` :

```ts
import { buildClubClosedMessage } from "./pollQuestion.js";

describe("buildClubClosedMessage", () => {
  it("préfixe puc fermé + date informelle + pas de squash", () => {
    const msg = buildClubClosedMessage("2026-08-15");
    expect(msg.startsWith("puc fermé ")).toBe(true);
    expect(msg.endsWith(" pas de squash")).toBe(true);
    expect(msg).toMatch(/15 août/);
  });
});

describe("buildPollQuestion avec closedTimes", () => {
  it("ajoute la mention des heures fermées", () => {
    const q = buildPollQuestion("2026-08-15", ["19H30"], ["18H45"]);
    expect(q).toContain("19h30");
    expect(q).toContain("18h45");
    expect(q).toContain("puc fermé");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm run test -w @squash-assistant/worker -- src/graph/nodes/pollQuestion.test.ts
```

- [ ] **Step 3: Implémentation**

Exporter `formatInformalDate` usage via nouvelles fonctions (garder helpers privés) :

```ts
export function buildClubClosedMessage(targetDate: string): string {
  return `puc fermé ${formatInformalDate(targetDate)} pas de squash`;
}

export function buildPollQuestion(
  targetDate: string,
  candidateStartTimes: string[],
  closedTimes: string[] = [],
): string {
  const timeLabel = formatSessionTimeList(candidateStartTimes);
  const base =
    candidateStartTimes.length > 1
      ? `Squash ${formatInformalDate(targetDate)}, à quelle heure : ${timeLabel} ?`
      : `Squash ${formatInformalDate(targetDate)} à ${timeLabel} ?`;
  if (closedTimes.length === 0) return base;
  const closedLabel = closedTimes.map(formatSessionTime).join(", ");
  return `${base} (${closedLabel} : puc fermé)`;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm run test -w @squash-assistant/worker -- src/graph/nodes/pollQuestion.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/graph/nodes/pollQuestion.ts apps/worker/src/graph/nodes/pollQuestion.test.ts
git commit -m "feat(worker): texts for club-closed poll and message"
```

---

### Task 4: Load DB + SendPoll + graphe + stage

**Files:**
- Create: `apps/worker/src/closures/loadClubClosures.ts`
- Modify: `apps/worker/src/graph/state.ts`
- Modify: `apps/worker/src/graph/nodes/sendPoll.ts`
- Modify: `apps/worker/src/graph/buildGraph.ts`
- Modify: `apps/worker/src/scheduler/scheduler.ts`
- Modify: `apps/worker/src/scheduler/cronDecisionPlan.test.ts` (si assertions sur stages terminaux)
- Test: étendre ou créer `apps/worker/src/graph/nodes/sendPoll.test.ts` si pattern de mocks existant ; sinon couvrir via test unitaire du helper de branchement extrait

**Interfaces:**
- Consumes: `filterCandidateTimesByClosures`, `buildClubClosedMessage`, `buildPollQuestion`, `sendMessage`, `askPoll`, `clubClosures` schema
- Produces: `loadClubClosuresForDate(db, targetDate): Promise<ClosureInterval[]>` ; state `clubClosed?: boolean` ; `afterSendPoll(state) => "end" | "waitForDecisionWindow"`

- [ ] **Step 1: Loader**

```ts
// apps/worker/src/closures/loadClubClosures.ts
import { and, gt, lt } from "drizzle-orm";
import { clubClosures } from "@squash-assistant/db/schema";
import type { Database } from "@squash-assistant/db/client";
import type { ClosureInterval } from "./filterCandidateTimes.js";
import { slotStartDateIsoHeuristicParis } from "../planning/teamrTime.js";

/** Intervalles qui chevauchent [00:00, 24:00) Paris de targetDate (via bornes heuristiques). */
export async function loadClubClosuresForDate(db: Database, targetDate: string): Promise<ClosureInterval[]> {
  const dayStartIso = slotStartDateIsoHeuristicParis(targetDate, "00H00");
  const next = new Date(`${targetDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextYmd = next.toISOString().slice(0, 10);
  const dayEndIso = slotStartDateIsoHeuristicParis(nextYmd, "00H00");
  if (!dayStartIso || !dayEndIso) return [];
  const dayStart = new Date(dayStartIso);
  const dayEnd = new Date(dayEndIso);
  const rows = await db
    .select()
    .from(clubClosures)
    .where(and(lt(clubClosures.startsAt, dayEnd), gt(clubClosures.endsAt, dayStart)));
  return rows.map((r) => ({ startsAt: r.startsAt, endsAt: r.endsAt }));
}
```

(Si la requête Drizzle avec `and/lt/gt` pose souci de types timestamp, charger les fermetures actives autour de la date avec un filtre large en JS.)

- [ ] **Step 2: State**

Dans `PipelineState` :

```ts
clubClosed: Annotation<boolean | undefined>(),
```

- [ ] **Step 3: `sendPoll` — logique A/B/C**

Remplacer le corps pour :

1. `const closures = await loadClubClosuresForDate(deps.db, targetDate)`
2. `const { openTimes, closedTimes } = filterCandidateTimesByClosures(targetDate, bookingRule.candidateStartTimes, closures)`
3. Si `openTimes.length === 0` :
   - `message = buildClubClosedMessage(targetDate)`
   - `withEventLogging(..., { type: "club-closed", ... }, async () => { await sendMessage(...); return { result: message, detail: { message, closedTimes } } })`
   - Telegram log arrêt
   - `return { clubClosed: true }`
4. Sinon :
   - `question = buildPollQuestion(targetDate, openTimes, closedTimes)`
   - `options = buildPollOptions(openTimes)`
   - `ask_poll` comme aujourd’hui
   - `return { pollRequestId: requestId, clubClosed: false }`

- [ ] **Step 4: Graphe**

```ts
.addConditionalEdges("sendPoll", (state: PipelineStateType) =>
  state.clubClosed ? END : "waitForDecisionWindow",
)
```

Retirer `.addEdge("sendPoll", "waitForDecisionWindow")`.

- [ ] **Step 5: `computeStage` + terminaux**

Dans `scheduler.ts` :

```ts
| "finished-club-closed"
```

Au début de `computeStage` :

```ts
if (values.clubClosed) {
  return "finished-club-closed";
}
```

Ajouter `"finished-club-closed"` à `TERMINAL_STAGES` (et à tout `skip-all` / cron decision plan qui liste les terminaux — lire `cronDecisionPlan` / tests associés et aligner).

- [ ] **Step 6: Tests**

- Mettre à jour `cronDecisionPlan.test.ts` : stage `finished-club-closed` → `skip-all`.
- Si pas de test sendPoll existant : tester une fonction exportée `resolveSendPollBranch({ openTimes })` n’est **pas** nécessaire si le graphe + computeStage sont couverts ; a minima un test unitaire :

```ts
// dans filter ou nouveau fichier sendPollBranch.test.ts
expect(openTimes.length === 0). // déjà couvert
```

Ajouter dans `scheduler` un petit test de `computeStage` si exporté ; sinon tester via le module qui expose `resolveCronDecisionPlan({ stage: "finished-club-closed" })`.

```bash
npm run worker:test
npm run worker:typecheck
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/closures/loadClubClosures.ts apps/worker/src/graph/ apps/worker/src/scheduler/
git commit -m "feat(worker): SendPoll respects club closures and finishes club-closed"
```

---

### Task 5: UI stage + labels events

**Files:**
- Modify: `apps/ui/src/lib/worker.ts`
- Modify: `apps/ui/src/app/rules/[id]/jobs/[jobId]/Pipeline.tsx`
- Modify: `apps/ui/src/app/rules/[id]/events/page.tsx`

**Interfaces:**
- Consumes: stage string `finished-club-closed` from worker API
- Produces: typage UI + affichage

- [ ] **Step 1: Étendre `PipelineStage` dans `worker.ts`**

```ts
| "finished-club-closed"
```

- [ ] **Step 2: Pipeline.tsx**

- Ajouter `"finished-club-closed"` à `STEP1_DONE`.
- `step1State` : si `finished-club-closed` → `"done"`.
- `step2State` / `step3State` / `step4State` : laisser `pending` pour ce stage (ne pas marquer étape 4 done).
- Afficher un paragraphe quand `stage === "finished-club-closed"` : `PUC fermé — pas de squash`.

- [ ] **Step 3: events/page.tsx**

Ajouter dans le map de labels stages / types d’événements :

```ts
"finished-club-closed": "terminé (PUC fermé)",
"club-closed": "fermeture PUC",
```

(adapter au dictionnaire existant du fichier)

- [ ] **Step 4: Typecheck UI**

```bash
npm run typecheck -w @squash-assistant/ui
```

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/lib/worker.ts apps/ui/src/app/rules/
git commit -m "feat(ui): display finished-club-closed pipeline stage"
```

---

### Task 6: Admin CRUD fermetures sur `/settings`

**Files:**
- Create: `apps/ui/src/lib/clubClosures.ts`
- Modify: `apps/ui/src/app/actions.ts`
- Modify: `apps/ui/src/app/settings/page.tsx`

**Interfaces:**
- Produces:

```ts
export async function listClubClosures(): Promise<ClubClosure[]>;
export async function createClubClosure(input: {
  startsAt: Date;
  endsAt: Date;
  label: string | null;
}): Promise<void>;
export async function deleteClubClosure(id: string): Promise<void>;
```

- [ ] **Step 1: `lib/clubClosures.ts`**

```ts
import { asc, eq } from "drizzle-orm";
import { clubClosures, type ClubClosure } from "@squash-assistant/db/schema";
import { getDb } from "./db";

export type { ClubClosure };

export async function listClubClosures(): Promise<ClubClosure[]> {
  return getDb().select().from(clubClosures).orderBy(asc(clubClosures.startsAt));
}

export async function createClubClosure(input: {
  startsAt: Date;
  endsAt: Date;
  label: string | null;
}): Promise<void> {
  if (!(input.endsAt.getTime() > input.startsAt.getTime())) {
    throw new Error("endsAt must be after startsAt");
  }
  await getDb().insert(clubClosures).values({
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    label: input.label,
  });
}

export async function deleteClubClosure(id: string): Promise<void> {
  await getDb().delete(clubClosures).where(eq(clubClosures.id, id));
}

/** datetime-local "YYYY-MM-DDTHH:mm" interprété Europe/Paris (heuristique DST mois). */
export function parisLocalInputToDate(local: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error(`invalid datetime-local: ${local}`);
  const [, ymd, hh, mm] = m;
  const month = Number(ymd!.slice(5, 7));
  const offset = month >= 4 && month <= 10 ? "+02:00" : "+01:00";
  return new Date(`${ymd}T${hh}:${mm}:00${offset}`);
}
```

- [ ] **Step 2: Actions**

```ts
export async function addClubClosureAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const startsAt = parisLocalInputToDate(String(formData.get("startsAt") ?? ""));
  const endsAt = parisLocalInputToDate(String(formData.get("endsAt") ?? ""));
  const labelRaw = String(formData.get("label") ?? "").trim();
  await createClubClosure({ startsAt, endsAt, label: labelRaw || null });
  revalidatePath("/settings");
}

export async function deleteClubClosureAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await deleteClubClosure(id);
  revalidatePath("/settings");
}
```

- [ ] **Step 3: Section UI `/settings`**

Sous les groupes WhatsApp, ajouter « Fermetures PUC » :

- `const closures = await listClubClosures()`
- Liste : pour chaque ligne, afficher début/fin formatés `fr-FR` timeZone `Europe/Paris`, label, form delete (disabled si !admin)
- Form add (fieldset disabled=!admin) : inputs `datetime-local` name `startsAt` / `endsAt`, text `label`, SubmitButton « Ajouter »

Helper d’affichage dans la page :

```tsx
function formatParis(d: Date): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    dateStyle: "short",
    timeStyle: "short",
  }).format(d);
}
```

- [ ] **Step 4: Vérifier manuellement / typecheck**

```bash
npm run typecheck -w @squash-assistant/ui
```

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/lib/clubClosures.ts apps/ui/src/app/actions.ts apps/ui/src/app/settings/page.tsx
git commit -m "feat(ui): admin CRUD for club closure intervals"
```

---

### Task 7: Spec fonctionnelle

**Files:**
- Modify: `docs/spec/regles-fonctionnelles.md`

**Interfaces:**
- Produit : section documentant le comportement utilisateur (pas l’implémentation)

- [ ] **Step 1: Ajouter une sous-section sous « Étape 1 — Sondage »**

```markdown
- **Fermetures PUC (2026-08-09)** : liste globale d'intervalles (`club_closures`, date+heure → date+heure, Europe/Paris) gérée par les admins dans `/settings`. Au SendPoll :
  - si **aucune** heure candidate du job ne tombe hors fermeture → message WhatsApp `puc fermé <jour> <date> pas de squash` à la place du sondage ; job terminé (`finished-club-closed`) ; pas de collecte / plan / annonce.
  - si **certaines** heures restent ouvertes → sondage uniquement sur ces heures ; la question mentionne les heures fermées (`… (18h45 : puc fermé)`).
  - une fermeture ajoutée **après** l'envoi du sondage ne recalcule pas le job en cours.
```

- [ ] **Step 2: Commit**

```bash
git add docs/spec/regles-fonctionnelles.md
git commit -m "docs(spec): fermetures PUC et comportement SendPoll"
```

---

## Self-Review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Table `club_closures` globale | Task 1 |
| Matching Paris, borne exclusive | Task 2 |
| Message cas A + stop job | Task 3 + 4 |
| Sondage filtré + mention | Task 3 + 4 |
| `clubClosed` + END + `finished-club-closed` | Task 4 |
| Event `club-closed` | Task 1 + 4 |
| UI stage | Task 5 |
| Admin CRUD `/settings` | Task 6 |
| Spec fonctionnelle | Task 7 |
| Hors scope respecté | Global Constraints |

Pas de TBD / placeholders restants après relecture.
