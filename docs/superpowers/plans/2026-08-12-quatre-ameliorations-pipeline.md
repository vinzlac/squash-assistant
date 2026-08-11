# Quatre améliorations du pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a next-day WhatsApp reminder step, remove jitter from the vote-collection cron, add a
detailed vote/booking synthesis message to the test WhatsApp group, and add a "solo voter cascades
to the next candidate time" rule to the local booking-plan engine.

**Architecture:** Four independent, small changes layered on the existing pipeline: (1) a new
per-rule cron in `cronRegistry.ts`/`scheduler.ts` that resends the already-computed announce
message the day after the match; (2) a one-line behavior change in `cronRegistry.ts` so
`decisionCron` fires without jitter; (3) a second WhatsApp message built from already-computed
plan data in `announce.ts`, gated on `reservationNotifyWhatsappGroupJid` being set; (4) a pure
preprocessing function in `planJob.ts` that runs before the existing per-time-slot planning loop.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), node-cron, LangGraph.js, Vitest, Next.js
(admin UI).

## Global Constraints

- Follow existing code style: French comments only where they explain a non-obvious "why" (see
  existing files), no unrequested refactors, no new abstractions beyond what each task needs.
- Every new/changed exported function needs a Vitest test in the same task.
- `npm run typecheck` and the affected workspace's tests must pass before each commit.
- No new ADR (per design doc) — update `docs/spec/regles-fonctionnelles.md` in the docs task.
- Never commit secrets; none of these tasks touch secrets.

---

### Task 1: Schema — `nextDayReminderEnabled` / `nextDayReminderSentAt`

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `apps/worker/src/jobRuns.ts`
- Create: `apps/worker/src/jobRuns.test.ts` (if it doesn't already exist — check first with `ls apps/worker/src/jobRuns.test.ts`; if it exists, add to it instead of overwriting)
- Modify (mechanical fixture update, 9 files):
  - `apps/worker/src/graph/nodes/announce.test.ts`
  - `apps/worker/src/graph/nodes/bookSlots.test.ts`
  - `apps/worker/src/graph/nodes/sendPoll.test.ts`
  - `apps/worker/src/planning/planJob.test.ts`
  - `apps/worker/src/planning/simulateScenario.test.ts`
  - `apps/worker/src/planning/scenarios.regression.test.ts`
  - `apps/worker/src/scheduler/scheduler.test.ts`
  - `apps/worker/src/scheduler/cronRegistry.test.ts`
  - `apps/worker/src/scripts/test-graph.ts`
- Migration: generated via `npm run db:generate` (do not hand-write the filename)

**Interfaces:**
- Produces: `BookingRule.nextDayReminderEnabled: boolean`, `JobRun.nextDayReminderSentAt: Date | null`
  (via `typeof jobRuns.$inferSelect`, no manual type edit needed for `JobRun`), and
  `markNextDayReminderSent(db: Database, jobId: string): Promise<void>` from `jobRuns.ts`.

- [ ] **Step 1: Add the two columns to the Drizzle schema**

In `packages/db/src/schema.ts`, add to the `BookingRule` interface (after
`requireTelegramGoForAutoJobs`):

```typescript
  /**
   * Envoie un rappel WhatsApp (reprise du message d'annonce) le lendemain de
   * `targetDate`, vers 0h05-0h15 (Europe/Paris) — voir regles-fonctionnelles.md.
   * Défaut false : n'affecte aucune règle existante sans validation explicite.
   */
  nextDayReminderEnabled: boolean;
```

And to the `bookingRules` table definition (after `requireTelegramGoForAutoJobs: boolean(...)`):

```typescript
  nextDayReminderEnabled: boolean("next_day_reminder_enabled").notNull().default(false),
```

In the `jobRuns` table definition, add (after the `auto` column):

```typescript
  /** Horodatage d'envoi du rappel J+1 (étape optionnelle) — null tant que non envoyé. Garde-fou anti-doublon (redémarrage du pod, plusieurs ticks du cron). */
  nextDayReminderSentAt: timestamp("next_day_reminder_sent_at"),
```

- [ ] **Step 2: Generate and apply the migration**

Run:
```bash
npm run db:generate -w @squash-assistant/db
```
Inspect the newly created file under `packages/db/src/migrations/` — it should contain two
`ALTER TABLE` statements (`booking_rules` adding `next_day_reminder_enabled boolean not null
default false`, `job_runs` adding `next_day_reminder_sent_at timestamp`). Then run:
```bash
npm run db:migrate -w @squash-assistant/db
```
Expected: migration applies without error against your local Postgres (from `docker-compose`,
per `AGENTS.md`).

- [ ] **Step 3: Add `markNextDayReminderSent` to `jobRuns.ts`**

In `apps/worker/src/jobRuns.ts`, add after `cancelJobRun`:

```typescript
/** Marque le rappel J+1 comme envoyé pour ce job — anti-doublon si le cron retick avant redémarrage propre. */
export async function markNextDayReminderSent(db: Database, jobId: string): Promise<void> {
  await db.update(jobRuns).set({ nextDayReminderSentAt: new Date() }).where(eq(jobRuns.id, jobId));
}
```

- [ ] **Step 4: Write a failing test for `markNextDayReminderSent`**

Check whether `apps/worker/src/jobRuns.test.ts` exists (`ls apps/worker/src/jobRuns.test.ts`). If
it exists, follow its existing DB test setup pattern (likely a real/test Postgres connection —
read the file's `beforeAll`/`beforeEach` to see how `db` is obtained and how a job is inserted
before asserting an update). If it does not exist, skip this step and instead add coverage in
Task 5's `scheduler.test.ts` additions (which exercise `markNextDayReminderSent` indirectly
through `triggerNextDayReminder` with a mocked `jobRuns.js` module) — note this explicitly in your
task notes so Task 5 doesn't skip asserting the DB write call.

- [ ] **Step 5: Run the affected test file(s) to confirm the current state**

Run: `npm run worker:test -- jobRuns` (or the project's equivalent single-file test command from
`AGENTS.md`)
Expected: existing tests still PASS (no behavior changed yet for existing functions).

- [ ] **Step 6: Update the 9 fixture files so `rule()`/`job()` helpers match the new required fields**

For the 8 files with a `rule()` fixture containing the line `requireTelegramGoForAutoJobs: true,`,
insert `nextDayReminderEnabled: false,` on the next line. Run:

```bash
for f in \
  apps/worker/src/graph/nodes/announce.test.ts \
  apps/worker/src/graph/nodes/bookSlots.test.ts \
  apps/worker/src/graph/nodes/sendPoll.test.ts \
  apps/worker/src/planning/planJob.test.ts \
  apps/worker/src/planning/simulateScenario.test.ts \
  apps/worker/src/planning/scenarios.regression.test.ts \
  apps/worker/src/scheduler/scheduler.test.ts \
  apps/worker/src/scheduler/cronRegistry.test.ts \
  apps/worker/src/scripts/test-graph.ts; do
  sed -i '' 's/requireTelegramGoForAutoJobs: true,/requireTelegramGoForAutoJobs: true,\n    nextDayReminderEnabled: false,/' "$f"
done
```

For `apps/worker/src/scheduler/scheduler.test.ts`, additionally locate its `job()` fixture
(containing the line `auto: true,`) and add `nextDayReminderSentAt: null,` on the next line:

```bash
sed -i '' 's/    auto: true,/    auto: true,\n    nextDayReminderSentAt: null,/' apps/worker/src/scheduler/scheduler.test.ts
```

Verify each edited file still has valid syntax by eye (`git diff apps/worker/src/scheduler/scheduler.test.ts` etc.) — the `sed` pattern is line-exact so it should only touch the intended fixture lines. If a file has the target line in more than one place (e.g. two `rule()` helpers), check with `grep -n "requireTelegramGoForAutoJobs: true," <file>` first and adjust manually with the Edit tool instead of `sed` for that file.

- [ ] **Step 7: Run the full worker test suite and typecheck**

Run: `npm run worker:test` and `npm run typecheck`
Expected: PASS — no compile errors from the new required fields, all existing tests green.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/migrations apps/worker/src/jobRuns.ts \
  apps/worker/src/graph/nodes/announce.test.ts apps/worker/src/graph/nodes/bookSlots.test.ts \
  apps/worker/src/graph/nodes/sendPoll.test.ts apps/worker/src/planning/planJob.test.ts \
  apps/worker/src/planning/simulateScenario.test.ts apps/worker/src/planning/scenarios.regression.test.ts \
  apps/worker/src/scheduler/scheduler.test.ts apps/worker/src/scheduler/cronRegistry.test.ts \
  apps/worker/src/scripts/test-graph.ts
git commit -m "feat(db): ajoute nextDayReminderEnabled et nextDayReminderSentAt"
```

---

### Task 2: UI — toggle `nextDayReminderEnabled` sur la règle

**Files:**
- Modify: `apps/ui/src/app/rules/RuleForm.tsx`
- Modify: `apps/ui/src/app/actions.ts:145-171`

**Interfaces:**
- Consumes: `BookingRule.nextDayReminderEnabled` (Task 1).
- Produces: form field `name="nextDayReminderEnabled"` (checkbox), submitted as `"on"`/absent.

- [ ] **Step 1: Add the checkbox to `RuleForm.tsx`**

In `apps/ui/src/app/rules/RuleForm.tsx`, right after the `requireTelegramGoForAutoJobs` `<label>`
block (ends around line 195 with `Attendre la confirmation Telegram &quot;go&quot;...`), add:

```tsx
        <label>
          <input
            type="checkbox"
            name="nextDayReminderEnabled"
            defaultChecked={source?.nextDayReminderEnabled ?? false}
          />{" "}
          Rappel WhatsApp le lendemain du match (~0h05-0h15, reprend le message d&apos;annonce)
        </label>
```

- [ ] **Step 2: Map the field in the server action**

In `apps/ui/src/app/actions.ts`, in the `values` object (around line 170, right after
`requireTelegramGoForAutoJobs: formData.get("requireTelegramGoForAutoJobs") === "on",`), add:

```typescript
    nextDayReminderEnabled: formData.get("nextDayReminderEnabled") === "on",
```

- [ ] **Step 3: Typecheck the UI workspace**

Run: `npm run ui:typecheck` (or `npm run typecheck` if there is no per-workspace script — check
`package.json` first)
Expected: PASS.

- [ ] **Step 4: Manually verify in the browser**

Run: `npm run ui:dev`, open a rule's edit page, confirm the new checkbox appears, toggle it, save,
reload the page, and confirm the checkbox state persisted.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/app/rules/RuleForm.tsx apps/ui/src/app/actions.ts
git commit -m "feat(ui): option rappel WhatsApp J+1 sur la règle"
```

---

### Task 3: `cronRegistry.ts` — decisionCron sans jitter

**Files:**
- Modify: `apps/worker/src/scheduler/cronRegistry.ts:92-109`
- Test: `apps/worker/src/scheduler/cronRegistry.test.ts`

**Interfaces:**
- Consumes: `scheduleWithCronJitter` from `./cronJitter.js` (unchanged signature).
- Produces: `decisionTask`'s cron callback now calls `rt.onDecision(fresh)` directly — no
  `scheduleWithCronJitter` involved for decision anymore.

- [ ] **Step 1: Write the failing test — decisionCron fires without jitter, pollCron still uses it**

Add to `apps/worker/src/scheduler/cronRegistry.test.ts`, near the top (after the existing
`vi.mock("../bookingRules.js", ...)` block):

```typescript
const scheduledCronCalls: Array<{ expr: string; cb: () => void }> = [];
vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((expr: string, cb: () => void) => {
      scheduledCronCalls.push({ expr, cb });
      return { stop: vi.fn() };
    }),
  },
}));

vi.mock("./cronJitter.js", () => ({
  scheduleWithCronJitter: vi.fn((_label: string, _windowMinutes: number, fn: () => Promise<void>) => {
    void fn();
  }),
}));

import { scheduleWithCronJitter } from "./cronJitter.js";
import { getBookingRuleById } from "../bookingRules.js";
```

Then add a new `describe` block at the end of the file:

```typescript
describe("jitter pollCron vs decisionCron", () => {
  beforeEach(() => {
    __resetCronRegistryForTests();
    scheduledCronCalls.length = 0;
    vi.mocked(scheduleWithCronJitter).mockClear();
    vi.mocked(getBookingRuleById).mockReset();
  });

  afterEach(() => {
    __resetCronRegistryForTests();
  });

  it("le tick pollCron passe par scheduleWithCronJitter, le tick decisionCron appelle onDecision directement", async () => {
    const onPoll = vi.fn(async () => {});
    const onDecision = vi.fn(async () => {});
    const testRule = rule({ pollCron: "0 10 * * 2", decisionCron: "30 21 * * 2" });
    vi.mocked(getBookingRuleById).mockResolvedValue(testRule);

    startCronRegistry([testRule], {
      graph: {} as never,
      telegram: { botToken: "t", chatId: "c" },
      db: {} as never,
      onPoll,
      onDecision,
    });

    const pollCall = scheduledCronCalls.find((c) => c.expr === "0 10 * * 2");
    const decisionCall = scheduledCronCalls.find((c) => c.expr === "30 21 * * 2");
    expect(pollCall).toBeDefined();
    expect(decisionCall).toBeDefined();

    pollCall!.cb();
    decisionCall!.cb();
    await vi.waitFor(() => {
      expect(onPoll).toHaveBeenCalledWith(testRule);
      expect(onDecision).toHaveBeenCalledWith(testRule);
    });

    expect(scheduleWithCronJitter).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleWithCronJitter).mock.calls[0]![0]).toContain("pollCron");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run worker:test -- cronRegistry`
Expected: FAIL — currently `decisionTask` also calls `scheduleWithCronJitter`, so
`scheduleWithCronJitter` is called twice, not once, and the "pollCron" label assertion may pass or
fail depending on call order, but the count assertion (`toHaveBeenCalledTimes(1)`) fails.

- [ ] **Step 3: Remove jitter from the decision branch**

In `apps/worker/src/scheduler/cronRegistry.ts`, replace the `decisionTask` definition:

```typescript
  const decisionTask = cron.schedule(
    rule.decisionCron,
    () => {
      void (async () => {
        const { getBookingRuleById } = await import("../bookingRules.js");
        const fresh = await getBookingRuleById(rt.db, ruleId);
        if (!fresh?.enabled) return;
        scheduleWithCronJitter(
          `${fresh.id} decisionCron`,
          fresh.cronJitterWindowMinutes ?? 60,
          () => rt.onDecision(fresh),
          Math.random,
          schedule,
        );
      })();
    },
    { timezone: TIMEZONE },
  );
```

with:

```typescript
  const decisionTask = cron.schedule(
    rule.decisionCron,
    () => {
      void (async () => {
        const { getBookingRuleById } = await import("../bookingRules.js");
        const fresh = await getBookingRuleById(rt.db, ruleId);
        if (!fresh?.enabled) return;
        // Pas de jitter ici (2026-08-12) : la collecte des votes doit se déclencher pile à
        // l'heure configurée — seul pollCron conserve le flou (cronJitterWindowMinutes).
        await rt.onDecision(fresh);
      })();
    },
    { timezone: TIMEZONE },
  );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run worker:test -- cronRegistry`
Expected: PASS.

- [ ] **Step 5: Run the full cronRegistry test file to confirm no regressions**

Run: `npm run worker:test -- cronRegistry`
Expected: all tests in the file PASS (existing "reload à chaud" tests unaffected by the `node-cron`
mock, since they only assert on `getScheduledRuleIds()`).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/scheduler/cronRegistry.ts apps/worker/src/scheduler/cronRegistry.test.ts
git commit -m "fix(scheduler): decisionCron se déclenche sans décalage aléatoire"
```

---

### Task 4: `cronRegistry.ts` — cron du rappel J+1

**Files:**
- Modify: `apps/worker/src/scheduler/cronRegistry.ts`
- Test: `apps/worker/src/scheduler/cronRegistry.test.ts`

**Interfaces:**
- Consumes: `BookingRule.nextDayReminderEnabled` (Task 1).
- Produces: `SchedulerRuntime.onReminder: (rule: BookingRule) => Promise<void>` — new required
  field on the interface, consumed by Task 5's `scheduler.ts`.

- [ ] **Step 1: Write the failing test**

Add to the `describe("jitter pollCron vs decisionCron", ...)` block (or a new adjacent
`describe`) in `cronRegistry.test.ts`:

```typescript
it("enregistre un 3e cron « rappel J+1 » (05 0 * * *) et l'appelle seulement si nextDayReminderEnabled", async () => {
  const onPoll = vi.fn(async () => {});
  const onDecision = vi.fn(async () => {});
  const onReminder = vi.fn(async () => {});
  const enabledRule = rule({ nextDayReminderEnabled: true });
  vi.mocked(getBookingRuleById).mockResolvedValue(enabledRule);

  startCronRegistry([enabledRule], {
    graph: {} as never,
    telegram: { botToken: "t", chatId: "c" },
    db: {} as never,
    onPoll,
    onDecision,
    onReminder,
  });

  const reminderCall = scheduledCronCalls.find((c) => c.expr === "5 0 * * *");
  expect(reminderCall).toBeDefined();

  reminderCall!.cb();
  await vi.waitFor(() => {
    expect(onReminder).toHaveBeenCalledWith(enabledRule);
  });
  expect(
    vi.mocked(scheduleWithCronJitter).mock.calls.some((c) => c[0] === `${enabledRule.id} reminderCron`),
  ).toBe(true);
});

it("n'appelle pas onReminder si nextDayReminderEnabled est false", async () => {
  const onReminder = vi.fn(async () => {});
  const disabledRule = rule({ nextDayReminderEnabled: false });
  vi.mocked(getBookingRuleById).mockResolvedValue(disabledRule);

  startCronRegistry([disabledRule], {
    graph: {} as never,
    telegram: { botToken: "t", chatId: "c" },
    db: {} as never,
    onPoll: async () => {},
    onDecision: async () => {},
    onReminder,
  });

  const reminderCall = scheduledCronCalls.find((c) => c.expr === "5 0 * * *");
  reminderCall!.cb();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(onReminder).not.toHaveBeenCalled();
});
```

Also update every other `startCronRegistry(...)` call already in the file (the two tests in
`describe("cronRegistry reload à chaud", ...)`) to pass `onReminder: async () => {}` alongside
`onPoll`/`onDecision`, since `SchedulerRuntime` will require it after Step 3 below.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run worker:test -- cronRegistry`
Expected: FAIL — `onReminder` isn't a recognized property yet / no cron with expr `"5 0 * * *"` is
registered.

- [ ] **Step 3: Add the reminder cron to `cronRegistry.ts`**

Add near the top of the file (after `const TIMEZONE = "Europe/Paris";`):

```typescript
const REMINDER_CRON_EXPRESSION = "5 0 * * *";
const REMINDER_JITTER_WINDOW_MINUTES = 10;
```

Update `SchedulerRuntime`:

```typescript
export interface SchedulerRuntime {
  graph: PipelineGraph;
  telegram: TelegramConfig;
  db: Database;
  /** Déclencheurs injectables pour tests — défaut = vrais triggerCron*. */
  onPoll: (rule: BookingRule) => Promise<void>;
  onDecision: (rule: BookingRule) => Promise<void>;
  onReminder: (rule: BookingRule) => Promise<void>;
}
```

Update `RuleCronHandles`:

```typescript
interface RuleCronHandles {
  pollTask: Stoppable;
  decisionTask: Stoppable;
  reminderTask: Stoppable;
  pendingTimeouts: Set<ReturnType<typeof setTimeout>>;
}
```

In `clearRuleHandles`, add `handles.reminderTask.stop();` alongside the existing
`pollTask.stop()`/`decisionTask.stop()` calls.

In `scheduleOne`, after the `decisionTask` definition and before `registry.set(...)`, add:

```typescript
  const reminderTask = cron.schedule(
    REMINDER_CRON_EXPRESSION,
    () => {
      void (async () => {
        const { getBookingRuleById } = await import("../bookingRules.js");
        const fresh = await getBookingRuleById(rt.db, ruleId);
        if (!fresh?.enabled || !fresh.nextDayReminderEnabled) return;
        scheduleWithCronJitter(
          `${fresh.id} reminderCron`,
          REMINDER_JITTER_WINDOW_MINUTES,
          () => rt.onReminder(fresh),
          Math.random,
          schedule,
        );
      })();
    },
    { timezone: TIMEZONE },
  );
```

Update `registry.set(ruleId, { pollTask, decisionTask, pendingTimeouts });` to:

```typescript
  registry.set(ruleId, { pollTask, decisionTask, reminderTask, pendingTimeouts });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run worker:test -- cronRegistry`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/scheduler/cronRegistry.ts apps/worker/src/scheduler/cronRegistry.test.ts
git commit -m "feat(scheduler): cron du rappel WhatsApp J+1 (05h00 Paris + jitter 10min)"
```

---

### Task 5: `scheduler.ts` — `triggerNextDayReminder` + wiring

**Files:**
- Modify: `apps/worker/src/scheduler/scheduler.ts`
- Modify: `apps/worker/src/index.ts`
- Test: `apps/worker/src/scheduler/scheduler.test.ts`

**Interfaces:**
- Consumes: `findActiveJobRunForDate`, `markNextDayReminderSent` (from `jobRuns.js`, Task 1);
  `computeTargetDate` (from `./weekKey.js`); `sendMessage` (from `../mcp/huddleBot.js`);
  `McpConnection` type (from `../mcp/client.js`); `SchedulerRuntime.onReminder` (Task 4).
- Produces: `triggerNextDayReminder(rule: BookingRule, graph: PipelineGraph, telegram:
  TelegramConfig, db: Database, huddleBot: McpConnection): Promise<void>`; updated
  `scheduleBookingRules(rules: BookingRule[], graph: PipelineGraph, telegram: TelegramConfig, db:
  Database, huddleBot: McpConnection): void`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/worker/src/scheduler/scheduler.test.ts`, after the existing imports:

```typescript
vi.mock("../jobRuns.js", () => ({
  findActiveJobRunForDate: vi.fn(),
  markNextDayReminderSent: vi.fn(async () => {}),
}));
vi.mock("../mcp/huddleBot.js", () => ({
  sendMessage: vi.fn(async () => {}),
}));
vi.mock("../telegram/telegram.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../telegram/telegram.js")>();
  return { ...actual, sendTelegramMessage: vi.fn(async () => {}) };
});

import { findActiveJobRunForDate, markNextDayReminderSent } from "../jobRuns.js";
import { sendMessage } from "../mcp/huddleBot.js";
import { sendTelegramMessage } from "../telegram/telegram.js";
import { triggerNextDayReminder } from "./scheduler.js";
```

Then add a new `describe` block:

```typescript
describe("triggerNextDayReminder", () => {
  const huddleBot = { client: {} as never, close: async () => {} };
  const telegram = { botToken: "t", chatId: "c" };

  beforeEach(() => {
    vi.mocked(findActiveJobRunForDate).mockReset();
    vi.mocked(markNextDayReminderSent).mockReset().mockResolvedValue(undefined);
    vi.mocked(sendMessage).mockReset().mockResolvedValue(undefined);
    vi.mocked(sendTelegramMessage).mockClear();
  });

  it("ne fait rien si aucun job actif pour la date cible", async () => {
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(undefined);
    const graph = { getState: vi.fn() } as unknown as PipelineGraph;

    await triggerNextDayReminder(rule(), graph, telegram, {} as never, huddleBot);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("ne fait rien si le rappel a déjà été envoyé pour ce job", async () => {
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(
      job({ nextDayReminderSentAt: new Date("2026-08-11T00:05:00Z") }),
    );
    const graph = { getState: vi.fn() } as unknown as PipelineGraph;

    await triggerNextDayReminder(rule(), graph, telegram, {} as never, huddleBot);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("ne fait rien si le job n'est pas dans l'état finished-announced", async () => {
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(job());
    const graph = {
      getState: vi.fn().mockResolvedValue({ next: ["waitForGoConfirmation"], values: {} }),
    } as unknown as PipelineGraph;

    await triggerNextDayReminder(rule(), graph, telegram, {} as never, huddleBot);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(markNextDayReminderSent).not.toHaveBeenCalled();
  });

  it("renvoie le message d'annonce déjà stocké et marque le rappel comme envoyé", async () => {
    const activeJob = job();
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(activeJob);
    const graph = {
      getState: vi.fn().mockResolvedValue({
        next: [],
        values: {
          pollRequestId: "poll-1",
          bookingPlanGroups: [
            { plan: { proposedBookings: [{ sessionId: "s1" }], warnings: [], meta: {} as never } },
          ],
          goConfirmed: true,
          announceMessage: "🏸 Réservation(s) confirmée(s) « test-rule »",
        },
      }),
    } as unknown as PipelineGraph;

    await triggerNextDayReminder(rule(), graph, telegram, {} as never, huddleBot);

    expect(sendMessage).toHaveBeenCalledWith(
      huddleBot.client,
      "g@test",
      "🏸 Réservation(s) confirmée(s) « test-rule »",
    );
    expect(markNextDayReminderSent).toHaveBeenCalledWith({}, activeJob.id);
  });
});
```

Note: `computeStage` (used internally by `getJobExecutionStatus`) derives `"finished-announced"`
from `pausedOnFromSnapshot(snapshot) === undefined`, `values.pollRequestId` set,
`values.bookingPlanGroups` having at least one non-empty `proposedBookings`, and
`values.goConfirmed === true` — the mock `getState` return values above satisfy this; verify
against `computeStage` in `scheduler.ts:64-88` if the test doesn't reach the expected stage.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run worker:test -- scheduler`
Expected: FAIL — `triggerNextDayReminder` is not exported yet.

- [ ] **Step 3: Implement `triggerNextDayReminder` in `scheduler.ts`**

Add these imports at the top of `apps/worker/src/scheduler/scheduler.ts`:

```typescript
import type { McpConnection } from "../mcp/client.js";
import { sendMessage } from "../mcp/huddleBot.js";
import { findActiveJobRunForDate, markNextDayReminderSent } from "../jobRuns.js";
import { computeTargetDate } from "./weekKey.js";
```

(`computeTargetDate` and `findActiveJobRunForDate` are likely already imported — check first and
merge into the existing `import { ... } from "./weekKey.js"` / `"../jobRuns.js"` lines instead of
duplicating.)

Add the function (after `triggerCronDecision`, before `recoverPendingGoWaits`):

```typescript
/**
 * Renvoie le message d'annonce déjà calculé (finished-announced) vers le groupe WhatsApp du
 * sondage, le lendemain de targetDate — étape optionnelle (BookingRule.nextDayReminderEnabled).
 * Idempotent via JobRun.nextDayReminderSentAt (résiste à un redémarrage du pod entre deux ticks).
 */
export async function triggerNextDayReminder(
  rule: BookingRule,
  graph: PipelineGraph,
  telegram: TelegramConfig,
  db: Database,
  huddleBot: McpConnection,
): Promise<void> {
  const targetDate = computeTargetDate(new Date(), -1);
  const job = await findActiveJobRunForDate(db, rule.id, targetDate);
  if (!job) return;
  if (job.nextDayReminderSentAt) return;

  const status = await getJobExecutionStatus(rule, job, graph);
  if (status.stage !== "finished-announced") return;
  const message = status.values.announceMessage;
  if (!message) return;

  await sendMessage(huddleBot.client, rule.whatsappGroupJid, message);
  await markNextDayReminderSent(db, job.id);
  await sendTelegramMessage(
    telegram,
    `[${rule.id}] Rappel J+1 envoyé pour le ${targetDate} (WhatsApp ${rule.whatsappGroupJid}).`,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run worker:test -- scheduler`
Expected: PASS.

- [ ] **Step 5: Wire `onReminder` into `scheduleBookingRules` and update the call site**

In `scheduler.ts`, update `scheduleBookingRules`:

```typescript
export function scheduleBookingRules(
  rules: BookingRule[],
  graph: PipelineGraph,
  telegram: TelegramConfig,
  db: Database,
  huddleBot: McpConnection,
): void {
  startCronRegistry(rules, {
    graph,
    telegram,
    db,
    onPoll: (rule) => triggerCronSendPoll(rule, graph, telegram, db),
    onDecision: (rule) => triggerCronDecision(rule, graph, telegram, db),
    onReminder: (rule) => triggerNextDayReminder(rule, graph, telegram, db, huddleBot),
  });
}
```

In `apps/worker/src/index.ts`, update the call site:

```typescript
  scheduleBookingRules(rules, graph, telegram, db, huddleBot);
```

(`huddleBot` is already in scope in `index.ts` from `await connectHuddleBot(...)` earlier in
`main()`.)

- [ ] **Step 6: Run typecheck and the full worker test suite**

Run: `npm run typecheck` and `npm run worker:test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/scheduler/scheduler.ts apps/worker/src/scheduler/scheduler.test.ts apps/worker/src/index.ts
git commit -m "feat(scheduler): déclencheur du rappel WhatsApp J+1"
```

---

### Task 6: `planJob.ts` — cascade joueur seul → heure suivante

**Files:**
- Modify: `apps/worker/src/planning/planJob.ts`
- Test: `apps/worker/src/planning/planJob.test.ts`

**Interfaces:**
- Produces: `cascadeSoloVotersForward(candidateStartTimes: string[], confirmedPlayerIdsByTime:
  Record<string, string[]>): Record<string, string[]>` (exported, pure function).

- [ ] **Step 1: Write the failing tests**

Add to `apps/worker/src/planning/planJob.test.ts`:

```typescript
import { cascadeSoloVotersForward, planJobBookings } from "./planJob.js";

describe("cascadeSoloVotersForward", () => {
  it("déplace un joueur seul vers l'heure candidate suivante", () => {
    const result = cascadeSoloVotersForward(
      ["18H45", "19H30"],
      { "18H45": ["terence"], "19H30": ["martin"] },
    );
    expect(result).toEqual({ "18H45": [], "19H30": ["martin", "terence"] });
  });

  it("ne déplace rien si le joueur a un partenaire à son heure", () => {
    const result = cascadeSoloVotersForward(
      ["18H45", "19H30"],
      { "18H45": ["terence", "julie"], "19H30": ["martin"] },
    );
    expect(result).toEqual({ "18H45": ["terence", "julie"], "19H30": ["martin"] });
  });

  it("ne cascade pas au-delà de l'heure suivante immédiate", () => {
    const result = cascadeSoloVotersForward(
      ["18H45", "19H30", "20H15"],
      { "18H45": ["terence"], "19H30": [], "20H15": ["martin", "julie"] },
    );
    // terence rejoint 19H30 (qui devient seul à son tour) — pas de 2e saut vers 20H15.
    expect(result).toEqual({ "18H45": [], "19H30": ["terence"], "20H15": ["martin", "julie"] });
  });

  it("ne déplace rien depuis la dernière heure candidate (pas d'heure suivante)", () => {
    const result = cascadeSoloVotersForward(["18H45", "19H30"], { "18H45": [], "19H30": ["martin"] });
    expect(result).toEqual({ "18H45": [], "19H30": ["martin"] });
  });
});

describe("planJobBookings — cascade joueur seul", () => {
  it("un joueur seul à la 1ère heure est réservé à la 2e heure avec le joueur qui y était", () => {
    const availableSlots = makeSlots([1, 2], "19H30", "20H15");
    const groups = planJobBookings(
      rule({ candidateStartTimes: ["18H45", "19H30"] }),
      "2026-08-08",
      { "18H45": ["terence"], "19H30": ["martin"] },
      [],
      availableSlots,
      null,
    );
    expect(groups[0]!.plan.proposedBookings).toEqual([]);
    expect(groups[1]!.plan.proposedBookings).toEqual([
      expect.objectContaining({ userId: "martin", partnerId: "terence" }),
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run worker:test -- planJob`
Expected: FAIL — `cascadeSoloVotersForward` is not exported yet, and the current
`planJobBookings` doesn't move the solo voter.

- [ ] **Step 3: Implement `cascadeSoloVotersForward` in `planJob.ts`**

Add near the top of `apps/worker/src/planning/planJob.ts`, before `applyUnexpectedPlayersMargin`:

```typescript
/**
 * Un joueur seul (aucun partenaire) à une heure candidate est déplacé vers l'heure candidate
 * suivante immédiate — on part du principe qu'un joueur disponible tôt l'est aussi plus tard,
 * jamais l'inverse (règle 2026-08-12, voir regles-fonctionnelles.md). Un seul saut : si l'heure
 * suivante devient à son tour seule après ce déplacement, elle n'est pas re-cascadée plus loin.
 * Fonction pure — appelée avant applyUnexpectedPlayersMargin (la cascade porte sur les votes
 * réels, pas sur les joueurs de marge ajoutés ensuite).
 */
export function cascadeSoloVotersForward(
  candidateStartTimes: string[],
  confirmedPlayerIdsByTime: Record<string, string[]>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const time of candidateStartTimes) {
    result[time] = [...(confirmedPlayerIdsByTime[time] ?? [])];
  }

  for (let i = 0; i < candidateStartTimes.length - 1; i += 1) {
    const time = candidateStartTimes[i]!;
    const nextTime = candidateStartTimes[i + 1]!;
    if (result[time]!.length === 1) {
      const [soloId] = result[time]!;
      result[time] = [];
      result[nextTime] = [...result[nextTime]!, soloId!];
    }
  }

  return result;
}
```

- [ ] **Step 4: Wire it into `planJobBookings`**

In `planJobBookings`, replace the first line of the function body:

```typescript
  const withMargin = applyUnexpectedPlayersMargin(bookingRule, confirmedPlayerIdsByTime, volunteerSubstituteIds);
```

with:

```typescript
  const cascaded = cascadeSoloVotersForward(bookingRule.candidateStartTimes, confirmedPlayerIdsByTime);
  const withMargin = applyUnexpectedPlayersMargin(bookingRule, cascaded, volunteerSubstituteIds);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run worker:test -- planJob`
Expected: PASS.

- [ ] **Step 6: Run the full worker test suite (regression check)**

Run: `npm run worker:test`
Expected: PASS — in particular check `scenarios.regression.test.ts` and `simulateScenario.test.ts`
still pass, since they exercise `planJobBookings` with real-world-derived fixtures that may
include single-voter candidate times where the old "not enough players" outcome is now expected
to change to a merge. If any of those tests fail because they asserted the old
"pas assez de joueurs" behavior for a genuinely-solo voter with a later candidate time available,
that is the intended behavior change from this task — update the assertion to match the new
cascaded outcome (re-derive it by running the test and reading the actual output, don't guess).

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/planning/planJob.ts apps/worker/src/planning/planJob.test.ts
git commit -m "feat(planning): cascade joueur seul vers l'heure candidate suivante"
```

---

### Task 7: `announce.ts` — synthèse votes/réservations pour le groupe de test

**Files:**
- Modify: `apps/worker/src/graph/nodes/announce.ts`
- Test: `apps/worker/src/graph/nodes/announce.test.ts`

**Interfaces:**
- Produces: `buildVoteBookingSynthesis(bookingRule: BookingRule, targetDate: string,
  confirmedPlayerIdsByTime: Record<string, string[]>, bookingPlanGroups: BookingPlanGroup[]):
  string` (exported, pure function).

- [ ] **Step 1: Write the failing tests**

Add to `apps/worker/src/graph/nodes/announce.test.ts`, updating the import line:

```typescript
const { createAnnounceNode, resolveReservationNotifyJid, resolveAnnounceNotifyJid, buildVoteBookingSynthesis } =
  await import("./announce.js");
```

Add a new `describe` block:

```typescript
describe("buildVoteBookingSynthesis", () => {
  it("liste les votes et les réservations effectuées", () => {
    const text = buildVoteBookingSynthesis(
      rule({ candidateStartTimes: ["18H45"] }),
      "2026-07-21",
      { "18H45": ["vincent", "stephane"] },
      [group()],
    );
    expect(text).toContain("vincent, stephane");
    expect(text).toContain("18H45");
    expect(text).toContain("court 4");
  });

  it("explique pourquoi une heure n'a rien réservé, via plan.warnings", () => {
    const emptyGroup = group({
      startTime: "19H30",
      plan: {
        dryRun: true,
        proposedBookings: [],
        warnings: ["Pas assez de joueurs confirmés à 19H30 (1/2 requis) pour proposer un créneau."],
        meta: {
          courtsNeeded: 0,
          roundsPlanned: 0,
          dryRun: true,
          groupLabel: "squashacademie-mardi",
          recurringWeekday: 2,
          recurringStartTime: "19H30",
          slotsPerPlayer: 0,
          groupMinSlotsPerPlayer: 0,
          groupMaxSlotsPerPlayer: 0,
          pairCount: 0,
        },
      },
    });
    const text = buildVoteBookingSynthesis(
      rule({ candidateStartTimes: ["19H30"] }),
      "2026-07-21",
      { "19H30": ["julie"] },
      [emptyGroup],
    );
    expect(text).toContain("Pas assez de joueurs confirmés");
  });
});

describe("createAnnounceNode — synthèse groupe de test", () => {
  it("envoie un 2e message de synthèse quand reservationNotifyWhatsappGroupJid est configuré", async () => {
    vi.mocked(sendMessage).mockClear();
    const state: PipelineStateType = {
      bookingRule: rule({ reservationNotifyWhatsappGroupJid: "vincent-all@g.us" }),
      jobRunId: "job-1",
      targetDate: "2026-07-21",
      pollRequestId: "poll-1",
      clubClosed: false,
      confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane"] },
      volunteerSubstituteIds: [],
      bookingPlanGroups: [group()],
      goConfirmed: true,
      dryRun: true,
      announceMessage: undefined,
    };

    await createAnnounceNode(deps())(state);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondCallArgs = vi.mocked(sendMessage).mock.calls[1]!;
    expect(secondCallArgs[1]).toBe("vincent-all@g.us");
    expect(secondCallArgs[2]).toContain("vincent, stephane");
  });

  it("n'envoie pas de 2e message si reservationNotifyWhatsappGroupJid n'est pas configuré", async () => {
    vi.mocked(sendMessage).mockClear();
    const state: PipelineStateType = {
      bookingRule: rule(),
      jobRunId: "job-1",
      targetDate: "2026-07-21",
      pollRequestId: "poll-1",
      clubClosed: false,
      confirmedPlayerIdsByTime: { "18H45": ["vincent", "stephane"] },
      volunteerSubstituteIds: [],
      bookingPlanGroups: [group()],
      goConfirmed: true,
      dryRun: true,
      announceMessage: undefined,
    };

    await createAnnounceNode(deps())(state);

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run worker:test -- announce`
Expected: FAIL — `buildVoteBookingSynthesis` is not exported yet, and only one `sendMessage` call
happens today regardless of `reservationNotifyWhatsappGroupJid`.

- [ ] **Step 3: Implement `buildVoteBookingSynthesis` in `announce.ts`**

Add near the top of `apps/worker/src/graph/nodes/announce.ts`, after the imports:

```typescript
/**
 * Synthèse texte (votes reçus vs réservations effectuées, avec raison si rien n'a été réservé)
 * — envoyée uniquement au groupe de test (reservationNotifyWhatsappGroupJid configuré), en plus
 * du message d'annonce habituel. Aucune donnée recalculée : réutilise confirmedPlayerIdsByTime
 * et bookingPlanGroups déjà produits par bookSlots.ts.
 */
export function buildVoteBookingSynthesis(
  bookingRule: BookingRule,
  targetDate: string,
  confirmedPlayerIdsByTime: Record<string, string[]>,
  bookingPlanGroups: BookingPlanGroup[],
): string {
  const votedTimes = bookingRule.candidateStartTimes.filter(
    (time) => (confirmedPlayerIdsByTime[time] ?? []).length > 0,
  );
  const votesBlock = votedTimes
    .map((time) => `• ${time} : ${(confirmedPlayerIdsByTime[time] ?? []).join(", ")}`)
    .join("\n");

  const groupsBlock = bookingPlanGroups
    .map((g) => {
      if (g.plan.proposedBookings.length === 0) {
        const reason = g.plan.warnings.join(" ") || "aucun détail disponible";
        return `• ${g.startTime} : rien réservé — ${reason}`;
      }
      const bookedList = g.plan.proposedBookings
        .map(
          (b) =>
            `${b.slotTime}-${b.slotEndTime} (court ${b.court}) ${b.userId}${b.partnerId ? ` et ${b.partnerId}` : ""}`,
        )
        .join(", ");
      const warningsSuffix = g.plan.warnings.length > 0 ? ` — ${g.plan.warnings.join(" ")}` : "";
      return `• ${g.startTime} : ${bookedList}${warningsSuffix}`;
    })
    .join("\n");

  return (
    `📊 Synthèse « ${bookingRule.id} » — ${targetDate}\n\n` +
    `Votes reçus :\n${votesBlock || "(aucun)"}\n\n` +
    `Réservations :\n${groupsBlock || "(aucune)"}`
  );
}
```

Add `BookingPlanGroup` to the existing `import type { BookingPlanGroup, PipelineStateType } from
"../state.js";` line (it's already imported — verify and reuse, don't duplicate the import).

- [ ] **Step 4: Wire it into `createAnnounceNode`**

In `createAnnounceNode`, update the destructure at the top:

```typescript
    const { bookingRule, jobRunId, targetDate, goConfirmed, bookingPlanGroups, dryRun, confirmedPlayerIdsByTime } = state;
```

After the existing `await sendMessage(deps.huddleBot.client, notifyJid, message);` line (still
inside the `withEventLogging` callback), add:

```typescript
        if (bookingRule.reservationNotifyWhatsappGroupJid) {
          const synthesis = buildVoteBookingSynthesis(bookingRule, targetDate, confirmedPlayerIdsByTime, groups);
          await sendMessage(deps.huddleBot.client, notifyJid, synthesis);
        }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run worker:test -- announce`
Expected: PASS.

- [ ] **Step 6: Run the full worker test suite (regression check)**

Run: `npm run worker:test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/graph/nodes/announce.ts apps/worker/src/graph/nodes/announce.test.ts
git commit -m "feat(announce): synthèse votes/réservations pour le groupe de test"
```

---

### Task 8: Documentation — `regles-fonctionnelles.md`

**Files:**
- Modify: `docs/spec/regles-fonctionnelles.md`

**Interfaces:**
- Consumes: nothing (pure documentation task).

- [ ] **Step 1: Update the jitter description**

Find the line (around line 26):

```
- **Flou horaire des crons auto (2026-08-04, `BookingRule.cronJitterWindowMinutes`, défaut 60)** : pour `pollCron` et `decisionCron`, l'heure configurée est le **début** d'une fenêtre de N minutes (éditable par règle, 0–120) ; l'action réelle (sondage / collecte+plan) part après un délai aléatoire uniforme dans `[0, N min)`. 0 = départ immédiat à l'heure cron. Délai en mémoire uniquement (pas de persistance) — un redémarrage du pod pendant l'attente annule le tir pour ce tick. Les déclenchements manuels UI ne sont **pas** affectés.
```

Replace with:

```
- **Flou horaire du cron auto (2026-08-04, mis à jour 2026-08-12, `BookingRule.cronJitterWindowMinutes`, défaut 60)** : s'applique uniquement à `pollCron` — l'heure configurée est le **début** d'une fenêtre de N minutes (éditable par règle, 0–120) ; l'envoi du sondage part après un délai aléatoire uniforme dans `[0, N min)`. 0 = départ immédiat à l'heure cron. Délai en mémoire uniquement (pas de persistance) — un redémarrage du pod pendant l'attente annule le tir pour ce tick. `decisionCron` (collecte des votes + calcul du plan) se déclenche **pile à l'heure configurée, sans décalage** (changement 2026-08-12 : la collecte doit être prévisible pour son destinataire). Les déclenchements manuels UI ne sont **pas** affectés.
```

- [ ] **Step 2: Document the next-day reminder step**

Find the section describing the pipeline steps / per-rule options (search for
`reservationNotifyWhatsappGroupJid` to locate the right neighborhood — likely near line 50-55) and
add a new bullet after it:

```
- **Rappel WhatsApp J+1 (2026-08-12, `BookingRule.nextDayReminderEnabled`, défaut false)** : étape optionnelle indépendante du pipeline LangGraph — un cron dédié par règle (05h00 Paris + jitter fixe 10 min, non configurable) vérifie chaque jour si un job de la règle a `targetDate` = hier et est au stade `finished-announced` ; si oui et que le rappel n'a pas déjà été envoyé (`JobRun.nextDayReminderSentAt`), il renvoie **tel quel** le message d'annonce déjà calculé (pas de recalcul) vers `whatsappGroupJid` (le groupe du sondage, pas le groupe de notification éventuel).
```

- [ ] **Step 3: Document the vote/booking synthesis message**

In the same neighborhood, add:

```
- **Synthèse votes/réservations pour le groupe de test (2026-08-12, `announce.ts`)** : quand `reservationNotifyWhatsappGroupJid` est configuré (mode test), un 2e message est envoyé après l'annonce habituelle — liste des votes reçus par heure candidate et, pour chaque heure, ce qui a été réservé ou la raison de l'échec (`plan.warnings`, déjà calculé par le moteur de plan). N'est jamais envoyé sur le groupe réel (`reservationNotifyWhatsappGroupJid` vide).
```

- [ ] **Step 4: Document the solo-voter cascade rule**

Find the existing rule about "Fusion cross-heures pour joueurs tardifs (règle 2026-08-05..." (around
line 93) and add a new bullet right after it:

```
- **Cascade joueur seul → heure suivante (règle 2026-08-12, `apps/worker/src/planning/planJob.ts`, `cascadeSoloVotersForward`)** : un joueur confirmé **seul** (sans partenaire) à une heure candidate est **déplacé** vers l'heure candidate **immédiatement suivante** avant tout calcul de plan — on part du principe qu'un joueur disponible tôt l'est aussi plus tard, jamais l'inverse. Un seul saut (pas de cascade transitive au-delà de l'heure suivante). Une heure vidée par ce déplacement est ensuite masquée par la règle d'affichage existante (2026-07-19, heure sans vote). Complémentaire — pas remplaçante — de la règle de fusion tardif→précédent ci-dessus, qui s'applique après planification (session déjà ouverte), pas avant.
```

- [ ] **Step 5: Add rows to the chronological changelog table**

Find the table at the bottom of the file (rows like `| 2026-08-05 | ... |`) and add, in date order:

```
| 2026-08-12 | `decisionCron` sans jitter (seul `pollCron` en conserve) | La collecte des votes doit être prévisible, pas approximative |
| 2026-08-12 | Rappel WhatsApp J+1 optionnel (`nextDayReminderEnabled`), cron dédié 05h Paris | Piqûre de rappel la veille du match sans repasser par le pipeline |
| 2026-08-12 | Synthèse votes/réservations vers le groupe de test (`announce.ts`) | Visibilité opérationnelle sur qui a voté vs ce qui a été réservé, sans polluer le groupe réel |
| 2026-08-12 | Cascade joueur seul vers l'heure candidate suivante (`cascadeSoloVotersForward`) | Un joueur seul en tôt peut jouer plus tard ; l'inverse n'est pas supposé vrai |
```

- [ ] **Step 6: Proofread the diff**

Run: `git diff docs/spec/regles-fonctionnelles.md`
Expected: 4 new bullets + 4 new table rows, no accidental edits to unrelated lines.

- [ ] **Step 7: Commit**

```bash
git add docs/spec/regles-fonctionnelles.md
git commit -m "docs: règles fonctionnelles pour les 4 améliorations du pipeline"
```

---

### Task 9: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: PASS across all workspaces (`apps/worker`, `apps/ui`, `apps/listener`, `packages/db`).
If `RuleGeneratorPanel.tsx` (`apps/ui/src/app/components/RuleGeneratorPanel.tsx:51`, which builds
a similar FormData-driven object for `requireTelegramGoForAutoJobs`) fails to compile because of
the new `nextDayReminderEnabled` field, add the same mapping pattern used in Task 2 Step 2 there.

- [ ] **Step 2: Full test suite**

Run: `npm test` (root) or `npm run worker:test && npm run listener:test` per `AGENTS.md`
Expected: PASS, including all files touched in Tasks 1, 3, 4, 5, 6, 7.

- [ ] **Step 3: Manual smoke check of the reminder cron registration**

Run: `npm run worker:dev`, check the startup log line `[scheduler] planifié « <rule> » poll=...
decision=... jitter=...` still prints correctly, and confirm no startup errors from the new
`reminderTask` registration (`cron.schedule("5 0 * * *", ...)` must not throw on a real node-cron
instance).

- [ ] **Step 4: Confirm git status is clean and all commits are present**

Run: `git log --oneline -10` and `git status`
Expected: 8 commits from Tasks 1–8 (in order), clean working tree.
