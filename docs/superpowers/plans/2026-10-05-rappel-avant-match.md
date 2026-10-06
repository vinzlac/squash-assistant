# Rappel WhatsApp avant le match — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Le jour du match, envoyer automatiquement un rappel WhatsApp (contenu de la confirmation + QR) X minutes (±10) avant le premier créneau réservé d'un job annoncé.

**Architecture:** Un tick global `* * * * *` (Europe/Paris) dans le worker appelle `triggerStartReminders(now)`. Une fonction pure `evaluateStartReminder` décide de l'état (envoyer / attendre / sauter / manqué) à partir de la règle live, du job et de l'état LangGraph ; elle sert aussi à l'API `handleJobStatus` pour l'UI (étape 6). L'envoi est protégé par une réservation atomique de la ligne `job_runs` avant `sendMessage`.

**Tech Stack:** TypeScript, Vitest, Drizzle ORM (Postgres), node-cron, LangGraph.js, Next.js (server components + server actions).

**Spec:** [`docs/superpowers/specs/2026-10-05-rappel-avant-match-design.md`](../specs/2026-10-05-rappel-avant-match-design.md) — à lire en entier avant de commencer.

## Global Constraints

- Délai par défaut `120` minutes, bornes **30–360** (entier) ; fenêtre fixe **±10 min**, décalage dans `[−10, +10)`.
- `start_reminder_enabled` défaut `false` (opt-in, aucun changement au déploiement).
- Destinataire = `resolveConfirmationNotifyJid(ruleLive)` — jamais un nouveau champ.
- Heures TeamR (`"18H45"`) lues **uniquement** via `parseTeamrTime` ; comparaisons en **minutes heure murale Paris** via `Intl` ; **interdit** : `slotStartDateIsoHeuristicParis`, `parisCalendarDayBoundsUtc`.
- `job_runs.start_reminder_sent_at` en `timestamp` **sans** fuseau, écrit par Drizzle `new Date()`, jamais `now()` SQL.
- Pas de rappel si `decisionDaysBefore === 0`. En dry-run, pas de rappel vers le groupe du sondage (`rule.whatsappGroupJid`).
- Réglages (enabled, délai, destinataire, `decisionDaysBefore`) lus sur la règle **live** ; contenu du message construit avec `status.values.bookingRule ?? job.ruleSnapshot ?? ruleLive`.
- Titres : rappel réel `⏰ Rappel — Squash aujourd'hui (<jour>)` ; rappel dry-run `⏰ Rappel (dry-run — aucun court réservé) — <jour>` ; confirmation **inchangée**.
- Ne **pas** ajouter les nouveaux champs à `packages/db/seeds/booking-rules.seed.json`.
- Migration appliquée automatiquement par l'initContainer (ADR-012) — ne jamais demander de lancer `db:migrate` hors dev local.
- Après modification de code : `graphify update .`.
- Commits : format conventionnel (`feat:`, `test:`, `docs:`…), terminés par `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Passage à l'heure d'hiver** (job du mardi 27/10/2026) : le rappel doit partir à 16h45 Paris, pas 15h45 — test `parisMinutesNow` (Task 3).
2. **Heure TeamR sans zéro** (`"9H00"` face à `"10H30"`) : le premier créneau doit être 9H00 — test `firstReservedSlotMinutes` (Task 3).
3. **Deux ticks/pods simultanés** : un seul message WhatsApp — test « deux ticks concurrents » (Task 4).
4. **Pod arrêté jusqu'après le début du créneau** : aucun envoi tardif, état `missed` — test « créneau commencé » (Task 3) et « tick après le premier créneau » (Task 4).
5. **Règle éditée après le lancement du job** (`candidateStartTimes` changé, délai changé) : lignes « Oui au sondage » issues du snapshot, délai issu de la règle live — test dédié (Task 4).

---

## File Structure

| Fichier | Rôle |
|---------|------|
| `packages/db/src/schema.ts` | +2 champs `BookingRule` (interface + table), +1 colonne `job_runs` |
| `packages/db/src/migrations/0032_start_reminder.sql` (+ meta) | Migration générée |
| `apps/worker/src/graph/nodes/announce.ts` | `variant` de `buildBookingConfirmationMessage` |
| `apps/worker/src/scheduler/startReminder.ts` (nouveau) | Fonctions pures : minutes Paris, premier créneau, décalage, évaluation de l'état |
| `apps/worker/src/jobRuns.ts` | `claimStartReminder`, `releaseStartReminder` |
| `apps/worker/src/scheduler/scheduler.ts` | `triggerStartReminders` + branchement |
| `apps/worker/src/scheduler/cronRegistry.ts` | Tick global unique |
| `apps/worker/src/http/server.ts` | `startReminder` dans la réponse `handleJobStatus` |
| `apps/ui/src/lib/worker.ts` | Type `StartReminderInfo`, `JobWithStatus.startReminder` |
| `apps/ui/src/app/rules/[id]/jobs/[jobId]/page.tsx`, `Pipeline.tsx` | Étape 6 |
| `apps/ui/src/lib/startReminderForm.ts` (nouveau) | Lecture/validation du délai |
| `apps/ui/src/app/actions.ts`, `rules/RuleForm.tsx`, `components/RuleGeneratorPanel.tsx` | Formulaire |
| `packages/db/src/ruleDescription.ts` | Phrase du rappel |
| `docs/spec/regles-fonctionnelles.md`, `docs/adr/ADR-036-…md`, `docs/adr/README.md` | Docs |

---

### Task 1: Schéma, migration et fixtures

**Files:**
- Modify: `packages/db/src/schema.ts` (interface `BookingRule` ~l.21-107, table `bookingRules` ~l.111-144, table `jobRuns` ~l.189-218)
- Create (généré): `packages/db/src/migrations/0032_start_reminder.sql`, `packages/db/src/migrations/meta/0032_snapshot.json`, modif `meta/_journal.json`
- Modify (ajout des 2 champs à chaque `BookingRule` complet): `packages/db/src/fixtures/realRules.ts`, `apps/worker/src/closures/closureImpact.test.ts`, `apps/worker/src/scheduler/cronRegistry.test.ts`, `apps/worker/src/scheduler/scheduler.test.ts`, `apps/worker/src/planning/planJob.test.ts`, `apps/worker/src/planning/simulateScenario.test.ts`, `apps/worker/src/planning/scenarios.regression.test.ts`, `apps/worker/src/graph/nodes/bookSlots.test.ts`, `apps/worker/src/graph/nodes/announce.test.ts`, `apps/worker/src/graph/nodes/sendPoll.test.ts`, `apps/worker/src/graph/nodes/collectVotes.test.ts`, `apps/worker/src/scripts/test-graph.ts`, `apps/ui/src/app/components/RuleGeneratorPanel.tsx`
- Modify (ajout `startReminderSentAt: null` aux `JobRun`): `apps/worker/src/closures/closureImpact.test.ts`, `apps/worker/src/scheduler/scheduler.test.ts`

**Interfaces:**
- Produces: `BookingRule.startReminderEnabled: boolean`, `BookingRule.startReminderMinutesBefore: number`, `JobRun.startReminderSentAt: Date | null`, colonnes Drizzle `bookingRules.startReminderEnabled`, `bookingRules.startReminderMinutesBefore`, `jobRuns.startReminderSentAt`.

- [ ] **Step 1: Ajouter les champs à l'interface `BookingRule`** — juste après `pinMessagesEnabled: boolean;` :

```ts
  /**
   * Rappel WhatsApp le jour du match, `startReminderMinutesBefore` minutes (±10) avant le
   * premier créneau réservé, vers le groupe de confirmation (spec 2026-10-05, ADR-036).
   * Inactif si `decisionDaysBefore === 0`. Défaut false.
   */
  startReminderEnabled: boolean;
  /** Délai du rappel avant le premier créneau réservé, en minutes (30–360). Défaut 120. */
  startReminderMinutesBefore: number;
```

- [ ] **Step 2: Ajouter les colonnes** — table `bookingRules`, après `pinMessagesEnabled: boolean("pin_messages_enabled")…,` :

```ts
  startReminderEnabled: boolean("start_reminder_enabled").notNull().default(false),
  startReminderMinutesBefore: integer("start_reminder_minutes_before").notNull().default(120),
```

Table `jobRuns`, après `nextDayReminderSentAt: timestamp("next_day_reminder_sent_at"),` :

```ts
  /** Rappel avant le match envoyé (ou en cours d'envoi : réservation atomique avant `sendMessage`) — null sinon. */
  startReminderSentAt: timestamp("start_reminder_sent_at"),
```

- [ ] **Step 3: Générer la migration**

Run: `(cd packages/db && npm run db:generate -- --name start_reminder)`
Expected: création de `packages/db/src/migrations/0032_start_reminder.sql` contenant exactement trois `ALTER TABLE … ADD COLUMN` (`start_reminder_enabled boolean DEFAULT false NOT NULL`, `start_reminder_minutes_before integer DEFAULT 120 NOT NULL`, `start_reminder_sent_at timestamp`), plus `meta/0032_snapshot.json` et une entrée dans `meta/_journal.json`. Ouvrir le SQL et vérifier qu'il n'y a rien d'autre.

- [ ] **Step 4: Reconstruire `packages/db`** (les autres workspaces lisent `packages/db/dist`)

Le build compile aussi `packages/db/src/fixtures/realRules.ts` (typé `Record<string, BookingRule>`) : **avant** de lancer le build, ajouter dans chacune des 3 règles de ce fichier, après `pinMessagesEnabled: …,` :

```ts
    startReminderEnabled: false,
    startReminderMinutesBefore: 120,
```

Run: `(cd packages/db && npm run build)`
Expected: succès.

- [ ] **Step 5: Lancer le typecheck pour lister les objets incomplets**

Run: `npm run typecheck`
Expected: FAIL — erreurs « Property 'startReminderEnabled' is missing » / « 'startReminderSentAt' is missing » dans les fichiers listés ci-dessus.

- [ ] **Step 6: Compléter chaque objet signalé**

Dans chaque fabrique / littéral `BookingRule` complet (ex. fonction `rule()` des tests, chaque règle de `REAL_RULES`, défauts de `RuleGeneratorPanel.tsx` ~l.65, `scripts/test-graph.ts`), ajouter après `pinMessagesEnabled: …,` :

```ts
    startReminderEnabled: false,
    startReminderMinutesBefore: 120,
```

Dans chaque fabrique `job()` / littéral `JobRun` signalé, ajouter après `nextDayReminderSentAt: …,` :

```ts
    startReminderSentAt: null,
```

Ne **pas** toucher `packages/db/seeds/booking-rules.seed.json`.

- [ ] **Step 7: Vérifier**

Run: `npm run typecheck && npm test`
Expected: PASS partout (aucun changement de comportement).

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/migrations packages/db/src/fixtures/realRules.ts apps/worker/src apps/ui/src/app/components/RuleGeneratorPanel.tsx
git commit -m "feat(db): colonnes du rappel avant le match (migration 0032)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Variante « rappel » du message de confirmation

**Files:**
- Modify: `apps/worker/src/graph/nodes/announce.ts:456-488` (`buildBookingConfirmationMessage`)
- Test: `apps/worker/src/graph/nodes/announce.test.ts` (nouveau `describe` en fin de fichier)

**Interfaces:**
- Produces: `export type BookingMessageVariant = "confirmation" | "start-reminder";` et `buildBookingConfirmationMessage(bookingRule, targetDate, bookingPlanGroups, confirmedPlayerIdsByTime, memberNames, realBooking, reservationFailures = [], variant: BookingMessageVariant = "confirmation"): string`.

- [ ] **Step 1: Écrire les tests**

Ajouter en fin de `announce.test.ts` (la fabrique `rule()` existe déjà l.94 ; `group` est déjà pris l.6, d'où le nom `groups` ci-dessous) :

```ts
describe("buildBookingConfirmationMessage — variant", () => {
  const groups = [
    {
      startTime: "18H45",
      outOfWindowSessionIds: [],
      plan: {
        proposedBookings: [{ sessionId: "s1", court: 4, userId: "u1", partnerId: "u2", slotTime: "18H45", slotEndTime: "19H30" }],
        warnings: [],
        dryRun: false,
        meta: {} as never,
      },
    },
  ] as BookingPlanGroup[];
  const votes = { "18H45": ["u1", "u2"] };
  const names = { u1: "Vincent", u2: "Stéphane" };

  it("sans variant : titre de confirmation inchangé (réel et dry-run)", () => {
    expect(buildBookingConfirmationMessage(rule({ candidateStartTimes: ["18H45"] }), "2026-08-11", groups, votes, names, true)).toMatch(
      /^✅ Confirmation — Réservation pour mardi\n/,
    );
    expect(buildBookingConfirmationMessage(rule({ candidateStartTimes: ["18H45"] }), "2026-08-11", groups, votes, names, false)).toMatch(
      /^✅ Confirmation — Réservation \(dry-run\) pour mardi\n/,
    );
  });

  it("start-reminder réel : titre rappel, même corps", () => {
    const text = buildBookingConfirmationMessage(rule({ candidateStartTimes: ["18H45"] }), "2026-08-11", groups, votes, names, true, [], "start-reminder");
    expect(text).toBe(
      "⏰ Rappel — Squash aujourd'hui (mardi)\n\n📅 2026-08-11\n\nCourt 4 : 18H45-19H30\n\nOui au sondage :\n• 18H45 : Vincent, Stéphane",
    );
  });

  it("start-reminder dry-run : le titre dit qu'aucun court n'est réservé", () => {
    const text = buildBookingConfirmationMessage(rule({ candidateStartTimes: ["18H45"] }), "2026-08-11", groups, votes, names, false, [], "start-reminder");
    expect(text.split("\n")[0]).toBe("⏰ Rappel (dry-run — aucun court réservé) — mardi");
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npm run worker:test -- announce.test.ts`
Expected: FAIL sur les deux tests `start-reminder` (titre `✅ Confirmation` reçu).

- [ ] **Step 3: Implémenter** — remplacer la fin de `buildBookingConfirmationMessage` :

```ts
export type BookingMessageVariant = "confirmation" | "start-reminder";

export function buildBookingConfirmationMessage(
  bookingRule: BookingRule,
  targetDate: string,
  bookingPlanGroups: BookingPlanGroup[],
  confirmedPlayerIdsByTime: Record<string, string[]>,
  memberNames: Record<string, string>,
  realBooking: boolean,
  reservationFailures: ReservationFailure[] = [],
  variant: BookingMessageVariant = "confirmation",
): string {
  // … corps inchangé jusqu'à votesSection …

  const weekday = formatWeekday(targetDate);
  const header =
    variant === "start-reminder"
      ? realBooking
        ? `⏰ Rappel — Squash aujourd'hui (${weekday})`
        : `⏰ Rappel (dry-run — aucun court réservé) — ${weekday}`
      : // Dry-run : la confirmation ne doit pas laisser croire que les courts sont vraiment pris.
        `✅ Confirmation — ${realBooking ? `Réservation pour ${weekday}` : `Réservation (dry-run) pour ${weekday}`}`;

  return `${header}\n\n📅 ${targetDate}\n\n${formatMergedCourtSlots(merged)}${votesSection}`;
}
```

Mettre à jour le JSDoc : « Confirmation WhatsApp des réservations (étape 5) ou rappel avant le match (`variant: "start-reminder"`, ADR-036) — … ».

- [ ] **Step 4: Vérifier**

Run: `npm run worker:test -- announce.test.ts scheduler.test.ts`
Expected: PASS (les tests existants de la confirmation restent verts).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/graph/nodes/announce.ts apps/worker/src/graph/nodes/announce.test.ts
git commit -m "feat(worker): variante rappel du message de confirmation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Fonctions pures du rappel

**Files:**
- Create: `apps/worker/src/scheduler/startReminder.ts`
- Test: `apps/worker/src/scheduler/startReminder.test.ts`

**Interfaces:**
- Consumes: `reservedBookings` (`../graph/nodes/announce.js`), `resolveConfirmationNotifyJid` (idem), `parseTeamrTime` (`../graph/capacityPlanning.js`), `computeTargetDate` (`./weekKey.js`), types `BookingPlanGroup`, `ReservationFailure` (`../graph/state.js`), `RuleExecutionStatus` (`./scheduler.js`, import **type** uniquement).
- Produces:
  - `START_REMINDER_JITTER_HALF_MINUTES = 10`
  - `START_REMINDER_SINCE: Date`
  - `START_REMINDER_REASONS` (objet de libellés)
  - `parisMinutesNow(now: Date): number`
  - `firstReservedSlotMinutes(groups: BookingPlanGroup[], failures: ReservationFailure[]): number | null`
  - `startReminderOffsetMinutes(jobId: string): number`
  - `formatParisMinutes(minutes: number): string` (ex. `1005 → "16h45"`)
  - `type StartReminderState = "disabled" | "skipped" | "waiting" | "due" | "sent" | "missed"`
  - `interface StartReminderEvaluation { state: StartReminderState; plannedAt?: string; reason?: string }`
  - `interface StartReminderInput { rule: StartReminderRule; job: StartReminderJob; isActiveJobForDate: boolean; status: Pick<RuleExecutionStatus, "stage" | "values">; now: Date }`
  - `evaluateStartReminder(input: StartReminderInput): StartReminderEvaluation`

- [ ] **Step 1: Écrire les tests**

```ts
import { describe, expect, it } from "vitest";
import type { BookingPlanGroup } from "../graph/state.js";
import {
  START_REMINDER_REASONS,
  START_REMINDER_SINCE,
  evaluateStartReminder,
  firstReservedSlotMinutes,
  formatParisMinutes,
  parisMinutesNow,
  startReminderOffsetMinutes,
  type StartReminderInput,
} from "./startReminder.js";

function group(startTime: string, slots: Array<{ id: string; time: string; end: string }>, outOfWindow: string[] = []): BookingPlanGroup {
  return {
    startTime,
    outOfWindowSessionIds: outOfWindow,
    plan: {
      proposedBookings: slots.map((s) => ({ sessionId: s.id, court: 2, userId: "u1", partnerId: "u2", slotTime: s.time, slotEndTime: s.end })),
      warnings: [],
      meta: {} as never,
    },
  } as BookingPlanGroup;
}

describe("parisMinutesNow", () => {
  it("heure d'été : 14:45Z → 16h45 Paris", () => {
    expect(parisMinutesNow(new Date("2026-08-11T14:45:00Z"))).toBe(16 * 60 + 45);
  });
  it("heure d'hiver (après le 25/10/2026) : 15:45Z → 16h45 Paris", () => {
    expect(parisMinutesNow(new Date("2026-10-27T15:45:00Z"))).toBe(16 * 60 + 45);
  });
  it("minuit Paris → 0", () => {
    expect(parisMinutesNow(new Date("2026-08-10T22:00:00Z"))).toBe(0);
  });
});

describe("firstReservedSlotMinutes", () => {
  it("prend le plus tôt en minutes, pas en texte (9H00 < 10H30)", () => {
    const groups = [group("10H30", [{ id: "a", time: "10H30", end: "11H15" }]), group("9H00", [{ id: "b", time: "9H00", end: "9H45" }])];
    expect(firstReservedSlotMinutes(groups, [])).toBe(9 * 60);
  });
  it("ignore les créneaux hors fenêtre et refusés", () => {
    const groups = [
      group("18H45", [
        { id: "a", time: "18H45", end: "19H30" },
        { id: "b", time: "19H30", end: "20H15" },
      ]),
      group("17H15", [{ id: "c", time: "17H15", end: "18H00" }], ["c"]),
    ];
    const failures = [{ sessionId: "a", court: 2, slotTime: "18H45", slotEndTime: "19H30", userId: "u1", partnerId: null, reason: null, message: "", rawError: "" }];
    expect(firstReservedSlotMinutes(groups, failures)).toBe(19 * 60 + 30);
  });
  it("lit le format TeamR « 18H45 » en minutes", () => {
    expect(firstReservedSlotMinutes([group("18H45", [{ id: "a", time: "18H45", end: "19H30" }])], [])).toBe(18 * 60 + 45);
  });
  it("null si aucun créneau réservé", () => {
    expect(firstReservedSlotMinutes([], [])).toBeNull();
  });
});

describe("startReminderOffsetMinutes", () => {
  it("stable pour un même id, toujours dans [-10, 10)", () => {
    for (const id of ["job-1", "a3f0c2d4-1111-2222-3333-444455556666", "x", ""]) {
      const v = startReminderOffsetMinutes(id);
      expect(v).toBe(startReminderOffsetMinutes(id));
      expect(v).toBeGreaterThanOrEqual(-10);
      expect(v).toBeLessThan(10);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("formatParisMinutes", () => {
  it("1005 → 16h45, 540 → 9h00", () => {
    expect(formatParisMinutes(1005)).toBe("16h45");
    expect(formatParisMinutes(540)).toBe("9h00");
  });
});

describe("evaluateStartReminder", () => {
  const JOB_ID = "job-1";
  const offset = startReminderOffsetMinutes(JOB_ID);
  // premier créneau 18H45, délai 120 → heure d'envoi 16h45 + offset
  const plannedMin = 18 * 60 + 45 - 120 + offset;
  const atParis = (minutes: number) => new Date(Date.UTC(2026, 7, 11, 0, 0) - 2 * 3600_000 + minutes * 60_000); // 2026-08-11, UTC+2

  function input(overrides: {
    rule?: Partial<StartReminderInput["rule"]>;
    job?: Partial<StartReminderInput["job"]>;
    isActiveJobForDate?: boolean;
    stage?: StartReminderInput["status"]["stage"];
    values?: Partial<StartReminderInput["status"]["values"]>;
    now?: Date;
  } = {}): StartReminderInput {
    return {
      rule: {
        enabled: true,
        startReminderEnabled: true,
        startReminderMinutesBefore: 120,
        decisionDaysBefore: 7,
        whatsappGroupJid: "origine@g.us",
        confirmationNotifyWhatsappGroupJid: null,
        ...overrides.rule,
      },
      job: {
        id: JOB_ID,
        targetDate: "2026-08-11",
        cancelledAt: null,
        createdAt: new Date(START_REMINDER_SINCE.getTime() + 1),
        startReminderSentAt: null,
        ...overrides.job,
      },
      isActiveJobForDate: overrides.isActiveJobForDate ?? true,
      status: {
        stage: overrides.stage ?? "finished-announced",
        values: {
          dryRun: false,
          reservationFailures: [],
          bookingPlanGroups: [group("18H45", [{ id: "s1", time: "18H45", end: "19H30" }])],
          ...overrides.values,
        },
      },
      now: overrides.now ?? atParis(plannedMin),
    };
  }

  it("1. déjà envoyé → sent (prime sur tout)", () => {
    expect(evaluateStartReminder(input({ job: { startReminderSentAt: new Date(), cancelledAt: new Date() } })).state).toBe("sent");
  });
  it("2. option décochée ou règle désactivée → disabled avec motif « Non activé »", () => {
    const expected = { state: "disabled", reason: START_REMINDER_REASONS.notEnabled };
    expect(evaluateStartReminder(input({ rule: { startReminderEnabled: false } }))).toEqual(expected);
    expect(evaluateStartReminder(input({ rule: { enabled: false } }))).toEqual(expected);
  });
  it("3. job créé avant la fonctionnalité → disabled sans motif (UI « — »), jamais missed", () => {
    const r = evaluateStartReminder(input({ job: { createdAt: new Date(START_REMINDER_SINCE.getTime() - 1), targetDate: "2026-08-01" } }));
    expect(r).toEqual({ state: "disabled" });
  });
  it("4. décision le jour du match → skipped", () => {
    expect(evaluateStartReminder(input({ rule: { decisionDaysBefore: 0 } }))).toEqual({ state: "skipped", reason: START_REMINDER_REASONS.sameDayDecision });
  });
  it("5. job annulé (et non annoncé) → motif annulé, prioritaire", () => {
    expect(evaluateStartReminder(input({ job: { cancelledAt: new Date() }, stage: "awaiting-go" })).reason).toBe(START_REMINDER_REASONS.cancelled);
  });
  it("6. pas le job actif de sa date → skipped", () => {
    expect(evaluateStartReminder(input({ isActiveJobForDate: false })).reason).toBe(START_REMINDER_REASONS.notActiveJob);
  });
  it("7. job non annoncé le jour du match (ou après) → skipped", () => {
    expect(evaluateStartReminder(input({ stage: "awaiting-go" }))).toEqual({ state: "skipped", reason: START_REMINDER_REASONS.notAnnounced });
    expect(evaluateStartReminder(input({ stage: "finished-no-plan", job: { targetDate: "2026-08-10" } })).reason).toBe(START_REMINDER_REASONS.notAnnounced);
  });
  it("7bis. job non annoncé, match à venir → waiting « En attente de l'annonce », sans heure", () => {
    expect(evaluateStartReminder(input({ stage: "awaiting-decision", job: { targetDate: "2026-08-15" } }))).toEqual({
      state: "waiting",
      reason: START_REMINDER_REASONS.awaitingAnnounce,
    });
  });
  it("8. aucun créneau réservé → skipped", () => {
    expect(evaluateStartReminder(input({ values: { bookingPlanGroups: [] } })).reason).toBe(START_REMINDER_REASONS.noReservedSlot);
  });
  it("9. dry-run vers le groupe du sondage → skipped ; vers un groupe de test → envoyable", () => {
    expect(evaluateStartReminder(input({ values: { dryRun: true } })).reason).toBe(START_REMINDER_REASONS.dryRunToPollGroup);
    expect(evaluateStartReminder(input({ values: { dryRun: true }, rule: { confirmationNotifyWhatsappGroupJid: "test@g.us" } })).state).toBe("due");
  });
  it("10. créneau commencé ou date passée → missed", () => {
    expect(evaluateStartReminder(input({ now: atParis(18 * 60 + 45) })).state).toBe("missed");
    expect(evaluateStartReminder(input({ job: { targetDate: "2026-08-10" } })).state).toBe("missed");
  });
  it("11. avant l'heure d'envoi ou date future → waiting avec l'heure prévue", () => {
    const r = evaluateStartReminder(input({ now: atParis(plannedMin - 1) }));
    expect(r).toEqual({ state: "waiting", plannedAt: formatParisMinutes(plannedMin) });
    expect(evaluateStartReminder(input({ job: { targetDate: "2026-08-12" } })).state).toBe("waiting");
  });
  it("12. heure d'envoi atteinte, créneau pas commencé → due", () => {
    expect(evaluateStartReminder(input()).state).toBe("due");
    expect(evaluateStartReminder(input({ now: atParis(18 * 60 + 44) })).state).toBe("due");
  });
  it("délai pris dans la règle passée (live) : 60 min → heure prévue 17h45 + offset", () => {
    const r = evaluateStartReminder(input({ rule: { startReminderMinutesBefore: 60 }, now: atParis(0) }));
    expect(r.plannedAt).toBe(formatParisMinutes(18 * 60 + 45 - 60 + offset));
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npm run worker:test -- startReminder.test.ts`
Expected: FAIL « Cannot find module './startReminder.js' ».

- [ ] **Step 3: Implémenter `startReminder.ts`**

```ts
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import { parseTeamrTime } from "../graph/capacityPlanning.js";
import { reservedBookings, resolveConfirmationNotifyJid } from "../graph/nodes/announce.js";
import type { BookingPlanGroup, ReservationFailure } from "../graph/state.js";
import type { RuleExecutionStatus } from "./scheduler.js";
import { computeTargetDate } from "./weekKey.js";

/**
 * Rappel WhatsApp avant le match (spec 2026-10-05, ADR-036). Toutes les heures sont des
 * minutes depuis minuit, heure murale de Paris, le jour de la date cible — jamais une Date
 * construite par heuristique de fuseau (fausse après le passage à l'heure d'hiver).
 */
export const START_REMINDER_JITTER_HALF_MINUTES = 10;

/** Mise en production de la fonctionnalité : un job créé avant n'a jamais eu de rappel (étape 6 « — », pas « non envoyé »). */
export const START_REMINDER_SINCE = new Date("2026-10-06T00:00:00Z");

export const START_REMINDER_REASONS = {
  notEnabled: "Non activé pour cette règle",
  sameDayDecision: "décision le jour du match",
  cancelled: "job annulé",
  notActiveJob: "pas le job actif de cette date",
  awaitingAnnounce: "En attente de l'annonce (étape 4)",
  notAnnounced: "job non annoncé",
  noReservedSlot: "aucun créneau réservé",
  dryRunToPollGroup: "dry-run vers le groupe d'origine",
} as const;

export type StartReminderState = "disabled" | "skipped" | "waiting" | "due" | "sent" | "missed";

export interface StartReminderEvaluation {
  state: StartReminderState;
  /** Heure d'envoi prévue, ex. « 16h45 » (Paris). */
  plannedAt?: string;
  reason?: string;
}

export type StartReminderRule = Pick<
  BookingRule,
  | "enabled"
  | "startReminderEnabled"
  | "startReminderMinutesBefore"
  | "decisionDaysBefore"
  | "whatsappGroupJid"
  | "confirmationNotifyWhatsappGroupJid"
>;

export type StartReminderJob = Pick<JobRun, "id" | "targetDate" | "cancelledAt" | "createdAt" | "startReminderSentAt">;

export interface StartReminderInput {
  /** Règle live (réglages opérationnels). */
  rule: StartReminderRule;
  job: StartReminderJob;
  /** Ce job est-il celui que retient `findActiveJobRunForDate` pour sa date ? */
  isActiveJobForDate: boolean;
  status: Pick<RuleExecutionStatus, "stage" | "values">;
  now: Date;
}

export function parisMinutesNow(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return hour * 60 + minute;
}

export function firstReservedSlotMinutes(groups: BookingPlanGroup[], failures: ReservationFailure[]): number | null {
  const minutes = reservedBookings(groups, failures)
    .map((b) => parseTeamrTime(b.slotTime))
    .filter((m): m is number => m !== null);
  return minutes.length > 0 ? Math.min(...minutes) : null;
}

/** Décalage stable dans [−10, +10) min, dérivé de l'id du job (FNV-1a 32 bits) — rien à stocker. */
export function startReminderOffsetMinutes(jobId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < jobId.length; i++) {
    hash ^= jobId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const width = START_REMINDER_JITTER_HALF_MINUTES * 2;
  return (hash % width) - START_REMINDER_JITTER_HALF_MINUTES;
}

export function formatParisMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

/** Premier état applicable, dans l'ordre du tableau « États du rappel et priorité » de la spec. */
export function evaluateStartReminder({ rule, job, isActiveJobForDate, status, now }: StartReminderInput): StartReminderEvaluation {
  if (job.startReminderSentAt) return { state: "sent" };
  if (!rule.enabled || !rule.startReminderEnabled) return { state: "disabled", reason: START_REMINDER_REASONS.notEnabled };
  if (job.createdAt < START_REMINDER_SINCE) return { state: "disabled" };
  if (rule.decisionDaysBefore === 0) return { state: "skipped", reason: START_REMINDER_REASONS.sameDayDecision };
  if (job.cancelledAt) return { state: "skipped", reason: START_REMINDER_REASONS.cancelled };
  if (!isActiveJobForDate) return { state: "skipped", reason: START_REMINDER_REASONS.notActiveJob };
  const today = computeTargetDate(now, 0);
  if (status.stage !== "finished-announced") {
    // Match à venir : le job peut encore être annoncé (comme l'étape 5, « en attente de l'annonce »).
    return job.targetDate > today
      ? { state: "waiting", reason: START_REMINDER_REASONS.awaitingAnnounce }
      : { state: "skipped", reason: START_REMINDER_REASONS.notAnnounced };
  }

  const firstSlot = firstReservedSlotMinutes(status.values.bookingPlanGroups ?? [], status.values.reservationFailures ?? []);
  if (firstSlot === null) return { state: "skipped", reason: START_REMINDER_REASONS.noReservedSlot };

  const realBooking = status.values.dryRun === false;
  if (!realBooking && resolveConfirmationNotifyJid(rule) === rule.whatsappGroupJid) {
    return { state: "skipped", reason: START_REMINDER_REASONS.dryRunToPollGroup };
  }

  const plannedMinutes = firstSlot - rule.startReminderMinutesBefore + startReminderOffsetMinutes(job.id);
  const plannedAt = formatParisMinutes(Math.max(0, plannedMinutes));
  const nowMinutes = parisMinutesNow(now);

  if (job.targetDate < today || (job.targetDate === today && nowMinutes >= firstSlot)) {
    return { state: "missed", plannedAt };
  }
  if (job.targetDate > today || nowMinutes < plannedMinutes) {
    return { state: "waiting", plannedAt };
  }
  return { state: "due", plannedAt };
}
```

Note : le test 11 attend `{ state: "waiting", plannedAt }` (`toEqual`) ; le test 4 attend `{ state: "skipped", reason }` sans `plannedAt` — conforme au code ci-dessus. Le test 10 (`missed`) n'utilise que `.state`.

- [ ] **Step 4: Vérifier**

Run: `npm run worker:test -- startReminder.test.ts`
Expected: PASS (toutes les lignes du tableau, DST, 9H00).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/scheduler/startReminder.ts apps/worker/src/scheduler/startReminder.test.ts
git commit -m "feat(worker): évaluation pure du rappel avant le match

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Envoi du rappel (`triggerStartReminders`)

**Files:**
- Modify: `apps/worker/src/jobRuns.ts` (après `markNextDayReminderSent`, ~l.148)
- Modify: `apps/worker/src/scheduler/scheduler.ts` (imports l.11-31, nouvelle fonction après `triggerBookingConfirmation` ~l.226)
- Test: `apps/worker/src/scheduler/scheduler.test.ts` (mock `../jobRuns.js` l.8-16, mock `../bookingRules.js`, nouveau `describe`)

**Interfaces:**
- Consumes: `evaluateStartReminder`, `START_REMINDER_REASONS` (Task 3) ; `buildBookingConfirmationMessage(..., "start-reminder")` (Task 2) ; `loadBookingRules(db)` (`../bookingRules.js`).
- Produces:
  - `claimStartReminder(db: Database, jobId: string): Promise<boolean>`
  - `releaseStartReminder(db: Database, jobId: string): Promise<void>`
  - `triggerStartReminders(now: Date, graph: PipelineGraph, telegram: TelegramConfig, db: Database, huddleBot: McpConnection, resaSquash: McpConnection): Promise<void>`
  - `__resetStartReminderLogForTests(): void`

- [ ] **Step 1: Ajouter les helpers DB** dans `jobRuns.ts` :

```ts
/**
 * Réserve l'envoi du rappel avant le match (ADR-036) : seul l'appelant qui obtient la ligne
 * envoie — anti-doublon entre ticks qui se chevauchent et entre pods (déploiement progressif).
 */
export async function claimStartReminder(db: Database, jobId: string): Promise<boolean> {
  const rows = await db
    .update(jobRuns)
    .set({ startReminderSentAt: new Date() })
    .where(and(eq(jobRuns.id, jobId), isNull(jobRuns.startReminderSentAt)))
    .returning({ id: jobRuns.id });
  return rows.length > 0;
}

/** Annule la réservation après un échec de `sendMessage` — le tick suivant réessaiera. */
export async function releaseStartReminder(db: Database, jobId: string): Promise<void> {
  await db.update(jobRuns).set({ startReminderSentAt: null }).where(eq(jobRuns.id, jobId));
}
```

- [ ] **Step 2: Écrire les tests** dans `scheduler.test.ts`.

Étendre le mock `../jobRuns.js` (l.8-16) :

```ts
    claimStartReminder: vi.fn(async () => true),
    releaseStartReminder: vi.fn(async () => {}),
```

Ajouter un mock des règles (après les autres `vi.mock`) :

```ts
vi.mock("../bookingRules.js", () => ({
  loadBookingRules: vi.fn(async () => []),
  getBookingRuleById: vi.fn(),
}));
```

Compléter les imports :

```ts
import { claimStartReminder, findActiveJobRunForDate, getJobRunById, markNextDayReminderSent, releaseStartReminder } from "../jobRuns.js";
import { loadBookingRules } from "../bookingRules.js";
import { __resetStartReminderLogForTests, triggerBookingConfirmation, triggerStartReminders } from "./scheduler.js";
import { START_REMINDER_SINCE, startReminderOffsetMinutes } from "./startReminder.js";
```

(fusionner avec les imports existants de `../jobRuns.js` et `./scheduler.js` au lieu de les dupliquer.)

Puis le `describe` :

```ts
describe("triggerStartReminders", () => {
  const huddleBot = { client: {} as never, close: async () => {} };
  const resaSquash = { client: {} as never, close: async () => {} };
  const telegram = { botToken: "t", chatId: "c" };
  const JOB_ID = "job-rappel";
  const offset = startReminderOffsetMinutes(JOB_ID);
  // 2026-08-11 (mardi, UTC+2) ; premier créneau 18H45, délai 120 → envoi à 16h45 + offset Paris
  const atParis = (minutes: number) => new Date(Date.UTC(2026, 7, 10, 22, 0) + minutes * 60_000);
  const dueNow = atParis(18 * 60 + 45 - 120 + offset);

  function reminderRule(overrides: Partial<BookingRule> = {}): BookingRule {
    return rule({ startReminderEnabled: true, startReminderMinutesBefore: 120, confirmationNotifyWhatsappGroupJid: "confirm@g.us", ...overrides });
  }
  function reminderJob(overrides: Partial<JobRun> = {}): JobRun {
    return job({ id: JOB_ID, targetDate: "2026-08-11", createdAt: new Date(START_REMINDER_SINCE.getTime() + 1), ...overrides });
  }
  function announcedGraph(values: Record<string, unknown> = {}): PipelineGraph {
    return {
      getState: vi.fn().mockResolvedValue({
        next: [],
        values: {
          pollRequestId: "poll-1",
          bookingRule: reminderRule(),
          confirmedPlayerIdsByTime: { "18H45": ["vincent"] },
          bookingPlanGroups: [
            {
              startTime: "18H45",
              outOfWindowSessionIds: [],
              plan: {
                proposedBookings: [{ sessionId: "s1", court: 4, userId: "vincent", slotTime: "18H45", slotEndTime: "19H30" }],
                warnings: [],
                meta: {} as never,
              },
            },
          ],
          goConfirmed: true,
          dryRun: false,
          reservationFailures: [],
          ...values,
        },
      }),
    } as unknown as PipelineGraph;
  }

  beforeEach(() => {
    __resetStartReminderLogForTests();
    vi.mocked(loadBookingRules).mockReset().mockResolvedValue([reminderRule()]);
    vi.mocked(findActiveJobRunForDate).mockReset().mockResolvedValue(reminderJob());
    vi.mocked(claimStartReminder).mockReset().mockResolvedValue(true);
    vi.mocked(releaseStartReminder).mockReset().mockResolvedValue(undefined);
    vi.mocked(sendMessage).mockReset().mockResolvedValue({});
    vi.mocked(sendBookingQrCodes).mockClear();
    vi.mocked(sendTelegramMessage).mockClear();
    vi.mocked(listGroupMembers).mockReset().mockResolvedValue({ members: [] });
  });

  it("nominal réel : réserve, envoie le rappel au groupe de confirmation, puis les QR, puis logue", async () => {
    await triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash);

    expect(findActiveJobRunForDate).toHaveBeenCalledWith(expect.anything(), "test-rule", "2026-08-11");
    expect(claimStartReminder).toHaveBeenCalledWith({}, JOB_ID);
    expect(sendMessage).toHaveBeenCalledWith(huddleBot.client, "confirm@g.us", expect.stringMatching(/^⏰ Rappel — Squash aujourd'hui \(mardi\)/));
    expect(sendBookingQrCodes).toHaveBeenCalledWith(expect.anything(), "confirm@g.us", expect.any(Array));
    expect(sendTelegramMessage).toHaveBeenCalledWith(telegram, "[test-rule] Rappel avant match envoyé pour le 2026-08-11 (WhatsApp confirm@g.us).");
  });

  it("avant l'heure d'envoi : ne réserve rien", async () => {
    await triggerStartReminders(atParis(12 * 60), announcedGraph(), telegram, {} as never, huddleBot, resaSquash);
    expect(claimStartReminder).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("tick après le premier créneau (pod resté arrêté) : aucun envoi tardif", async () => {
    await triggerStartReminders(atParis(18 * 60 + 50), announcedGraph(), telegram, {} as never, huddleBot, resaSquash);
    expect(claimStartReminder).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("deux ticks concurrents : un seul envoi (la réservation n'est obtenue qu'une fois)", async () => {
    vi.mocked(claimStartReminder).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await Promise.all([
      triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash),
      triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash),
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("échec de sendMessage : libère la réservation, un seul log d'erreur sur deux ticks, puis envoi au tick suivant", async () => {
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("huddle down")).mockRejectedValueOnce(new Error("huddle down")).mockResolvedValue({});
    await triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash);
    await triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash);
    expect(releaseStartReminder).toHaveBeenCalledTimes(2);
    const errorLogs = vi.mocked(sendTelegramMessage).mock.calls.filter(([, text]) => String(text).includes("Rappel avant match non envoyé"));
    expect(errorLogs).toHaveLength(1);
    expect(sendBookingQrCodes).not.toHaveBeenCalled();

    await triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash);
    expect(sendBookingQrCodes).toHaveBeenCalledTimes(1);
  });

  it("dry-run vers le groupe du sondage : aucun envoi", async () => {
    vi.mocked(loadBookingRules).mockResolvedValue([reminderRule({ confirmationNotifyWhatsappGroupJid: null })]);
    await triggerStartReminders(dueNow, announcedGraph({ dryRun: true }), telegram, {} as never, huddleBot, resaSquash);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("dry-run vers un groupe de test : rappel dry-run, sans QR", async () => {
    await triggerStartReminders(dueNow, announcedGraph({ dryRun: true }), telegram, {} as never, huddleBot, resaSquash);
    expect(sendMessage).toHaveBeenCalledWith(huddleBot.client, "confirm@g.us", expect.stringMatching(/^⏰ Rappel \(dry-run — aucun court réservé\)/));
    expect(sendBookingQrCodes).not.toHaveBeenCalled();
  });

  it("job non annoncé le jour cible : un seul log Telegram sur plusieurs ticks, aucun envoi", async () => {
    const graph = { getState: vi.fn().mockResolvedValue({ next: ["waitForGoConfirmation"], values: { pollRequestId: "p" } }) } as unknown as PipelineGraph;
    await triggerStartReminders(atParis(1), graph, telegram, {} as never, huddleBot, resaSquash);
    await triggerStartReminders(atParis(2), graph, telegram, {} as never, huddleBot, resaSquash);
    const logs = vi.mocked(sendTelegramMessage).mock.calls.filter(([, text]) => String(text).includes("job non annoncé"));
    expect(logs).toHaveLength(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("job terminé sans annonce (rien à réserver) le jour cible : aucun log Telegram", async () => {
    const graph = { getState: vi.fn().mockResolvedValue({ next: [], values: { pollRequestId: "p", bookingPlanGroups: [] } }) } as unknown as PipelineGraph;
    await triggerStartReminders(atParis(1), graph, telegram, {} as never, huddleBot, resaSquash);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("règle éditée après le job : délai de la règle live, votes depuis le snapshot", async () => {
    // Live : délai 60 et candidateStartTimes sans 18H45 ; snapshot (état du graphe) : 18H45.
    vi.mocked(loadBookingRules).mockResolvedValue([reminderRule({ startReminderMinutesBefore: 60, candidateStartTimes: ["19H30"] })]);
    // À l'heure prévue pour 120 min, on est trop tôt pour 60 min → rien.
    await triggerStartReminders(dueNow, announcedGraph({ bookingRule: reminderRule({ candidateStartTimes: ["18H45"] }) }), telegram, {} as never, huddleBot, resaSquash);
    expect(sendMessage).not.toHaveBeenCalled();

    await triggerStartReminders(
      atParis(18 * 60 + 45 - 60 + offset),
      announcedGraph({ bookingRule: reminderRule({ candidateStartTimes: ["18H45"] }) }),
      telegram,
      {} as never,
      huddleBot,
      resaSquash,
    );
    expect(sendMessage).toHaveBeenCalledWith(huddleBot.client, "confirm@g.us", expect.stringContaining("• 18H45 : vincent"));
  });

  it("plusieurs jobs pour la date : seul le job actif (findActiveJobRunForDate) est traité", async () => {
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(reminderJob({ id: JOB_ID }));
    await triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash);
    expect(findActiveJobRunForDate).toHaveBeenCalledTimes(1);
    expect(claimStartReminder).toHaveBeenCalledTimes(1);
    expect(claimStartReminder).toHaveBeenCalledWith({}, JOB_ID);
  });

  it("règle sans rappel activé : ne cherche même pas de job", async () => {
    vi.mocked(loadBookingRules).mockResolvedValue([reminderRule({ startReminderEnabled: false })]);
    await triggerStartReminders(dueNow, announcedGraph(), telegram, {} as never, huddleBot, resaSquash);
    expect(findActiveJobRunForDate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Vérifier l'échec**

Run: `npm run worker:test -- scheduler.test.ts`
Expected: FAIL « triggerStartReminders is not exported » (ou équivalent).

- [ ] **Step 4: Implémenter dans `scheduler.ts`**

Imports à compléter :

```ts
import { loadBookingRules } from "../bookingRules.js";
import {
  claimStartReminder,
  createJobRun,
  findActiveJobRunForDate,
  getJobRunById,
  listJobRuns,
  markNextDayReminderSent,
  releaseStartReminder,
  threadIdForJob,
} from "../jobRuns.js";
import { START_REMINDER_REASONS, evaluateStartReminder } from "./startReminder.js";
```

Après `triggerBookingConfirmation` :

```ts
/** Jobs déjà signalés sur Telegram (non annoncé / échec d'envoi) — un seul log par job, perdu au redémarrage. */
const startReminderLoggedJobIds = new Set<string>();

export function __resetStartReminderLogForTests(): void {
  startReminderLoggedJobIds.clear();
}

/** Stages d'un job resté bloqué avant l'annonce — seuls cas signalés sur Telegram le jour du match. */
const STUCK_STAGES: readonly PipelineStage[] = ["not-started", "awaiting-decision", "awaiting-plan", "awaiting-go", "error"];

async function logStartReminderOnce(telegram: TelegramConfig, jobId: string, text: string): Promise<void> {
  if (startReminderLoggedJobIds.has(jobId)) return;
  startReminderLoggedJobIds.add(jobId);
  await sendTelegramMessage(telegram, text);
}

/**
 * Rappel WhatsApp avant le match (ADR-036), appelé par le tick global chaque minute.
 * Réglages lus sur la règle live ; contenu du message construit avec la règle figée du job.
 * Réservation atomique de la ligne avant l'envoi : au plus un message par job.
 */
export async function triggerStartReminders(
  now: Date,
  graph: PipelineGraph,
  telegram: TelegramConfig,
  db: Database,
  huddleBot: McpConnection,
  resaSquash: McpConnection,
): Promise<void> {
  const today = computeTargetDate(now, 0);
  const rules = (await loadBookingRules(db)).filter((r) => r.enabled && r.startReminderEnabled);
  for (const rule of rules) {
    try {
      await sendStartReminderIfDue(rule, today, now, graph, telegram, db, huddleBot, resaSquash);
    } catch (err) {
      console.error(`[scheduler] rappel avant match « ${rule.id} » échec :`, err);
    }
  }
}

async function sendStartReminderIfDue(
  rule: BookingRule,
  today: string,
  now: Date,
  graph: PipelineGraph,
  telegram: TelegramConfig,
  db: Database,
  huddleBot: McpConnection,
  resaSquash: McpConnection,
): Promise<void> {
  const job = await findActiveJobRunForDate(db, rule.id, today);
  if (!job || job.startReminderSentAt) return;

  const status = await getJobExecutionStatus(rule, job, graph);
  const evaluation = evaluateStartReminder({ rule, job, isActiveJobForDate: true, status, now });
  if (evaluation.state === "skipped" && evaluation.reason === START_REMINDER_REASONS.notAnnounced) {
    // Log seulement si le job est resté bloqué — un job terminé sans annonce (rien à réserver,
    // pas de go, club fermé) est normal et ne doit pas faire de bruit chaque jour de match.
    if (!STUCK_STAGES.includes(status.stage)) return;
    await logStartReminderOnce(telegram, job.id, `[${rule.id}] Rappel avant match non envoyé pour le ${today} — job non annoncé (étape 4).`);
    return;
  }
  if (evaluation.state !== "due") return;
  if (!(await claimStartReminder(db, job.id))) return;

  const contentRule = status.values.bookingRule ?? job.ruleSnapshot ?? rule;
  const realBooking = status.values.dryRun === false;
  const memberNames = await fetchMemberNames(resaSquash, rule.resaSquashGroupId).catch(() => ({}));
  const message = buildBookingConfirmationMessage(
    contentRule,
    job.targetDate,
    status.values.bookingPlanGroups ?? [],
    status.values.confirmedPlayerIdsByTime ?? {},
    memberNames,
    realBooking,
    status.values.reservationFailures ?? [],
    "start-reminder",
  );
  const notifyJid = resolveConfirmationNotifyJid(rule);

  try {
    await sendMessage(huddleBot.client, notifyJid, message);
  } catch (err) {
    await releaseStartReminder(db, job.id);
    await logStartReminderOnce(
      telegram,
      job.id,
      `[${rule.id}] Rappel avant match non envoyé pour le ${today} (${(err as Error).message}) — nouvel essai chaque minute jusqu'au premier créneau.`,
    );
    return;
  }

  if (realBooking) {
    const bookings = reservedBookings(status.values.bookingPlanGroups ?? [], status.values.reservationFailures ?? []);
    await sendBookingQrCodes({ resaSquash, huddleBot }, notifyJid, bookings);
  }
  await sendTelegramMessage(telegram, `[${rule.id}] Rappel avant match envoyé pour le ${today} (WhatsApp ${notifyJid}).`);
}
```

Note : `BookingRule` est importé depuis `../config.js` dans ce fichier ; `status.values.bookingRule` est du même type. Si `job.ruleSnapshot` (type `@squash-assistant/db/schema`) n'est pas assignable, les deux types sont identiques (re-export) — ne pas caster.

- [ ] **Step 5: Vérifier**

Run: `npm run worker:test -- scheduler.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/jobRuns.ts apps/worker/src/scheduler/scheduler.ts apps/worker/src/scheduler/scheduler.test.ts
git commit -m "feat(worker): envoi du rappel avant le match avec réservation atomique

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Tick global dans le registre des crons

**Files:**
- Modify: `apps/worker/src/scheduler/cronRegistry.ts` (interface `SchedulerRuntime` l.27-35, `startCronRegistry` l.185-197, `__resetCronRegistryForTests` l.200-203)
- Modify: `apps/worker/src/scheduler/scheduler.ts:162-169` (`scheduleBookingRules`)
- Test: `apps/worker/src/scheduler/cronRegistry.test.ts`

**Interfaces:**
- Consumes: `triggerStartReminders` (Task 4).
- Produces: `SchedulerRuntime.onStartReminderTick: (now: Date) => Promise<void>` ; constante `START_REMINDER_TICK_CRON = "* * * * *"`.

- [ ] **Step 1: Écrire / adapter les tests** dans `cronRegistry.test.ts`.

Ajouter `onStartReminderTick: async () => {}` (ou `vi.fn(async () => {})`) à **chaque** objet passé à `startCronRegistry` dans le fichier (rechercher `onConfirmation:` : chaque occurrence a besoin du nouveau champ à côté).

Modifier l'attente du test « dérive les crons du jour cible » :

```ts
    expect(scheduledCronCalls.map((c) => c.expr)).toEqual(["0 10 * * 2", "30 21 * * 4", "20 22 * * 4", "* * * * *"]);
```

Ajouter :

```ts
describe("tick global du rappel avant le match", () => {
  beforeEach(() => {
    __resetCronRegistryForTests();
    scheduledCronCalls.length = 0;
    vi.mocked(loadBookingRules).mockReset();
  });

  afterEach(() => {
    __resetCronRegistryForTests();
  });

  const runtime = (onStartReminderTick: (now: Date) => Promise<void>) => ({
    graph: {} as never,
    telegram: { botToken: "t", chatId: "c" },
    db: {} as never,
    onPoll: async () => {},
    onDecision: async () => {},
    onConfirmation: async () => {},
    onStartReminderTick,
  });

  it("un seul tick, même après plusieurs startCronRegistry et un reload", async () => {
    startCronRegistry([], runtime(async () => {}));
    startCronRegistry([], runtime(async () => {}));
    vi.mocked(loadBookingRules).mockResolvedValue([rule({ enabled: true })]);
    await reloadScheduler();

    const ticks = scheduledCronCalls.filter((c) => c.expr === "* * * * *");
    expect(ticks).toHaveLength(2); // un par startCronRegistry
    const cron = (await import("node-cron")).default;
    const tickHandles = vi.mocked(cron.schedule).mock.results
      .filter((_, i) => vi.mocked(cron.schedule).mock.calls[i]?.[0] === "* * * * *")
      .map((r) => r.value as { stop: ReturnType<typeof vi.fn> });
    expect(tickHandles.at(-2)!.stop).toHaveBeenCalled(); // l'ancien est arrêté
    expect(tickHandles.at(-1)!.stop).not.toHaveBeenCalled(); // le courant survit au reload
  });

  it("le tick appelle onStartReminderTick avec l'instant courant et avale ses erreurs", async () => {
    const onTick = vi.fn(async () => {
      throw new Error("boom");
    });
    startCronRegistry([], runtime(onTick));
    const tick = scheduledCronCalls.find((c) => c.expr === "* * * * *")!;
    expect(() => tick.cb()).not.toThrow();
    await Promise.resolve();
    expect(onTick).toHaveBeenCalledWith(expect.any(Date));
  });

  it("le reset de test arrête le tick", async () => {
    startCronRegistry([], runtime(async () => {}));
    const cron = (await import("node-cron")).default;
    const handle = vi.mocked(cron.schedule).mock.results.at(-1)!.value as { stop: ReturnType<typeof vi.fn> };
    __resetCronRegistryForTests();
    expect(handle.stop).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npm run worker:test -- cronRegistry.test.ts`
Expected: FAIL (aucun cron `* * * * *` planifié ; erreur de type sur `onStartReminderTick` au typecheck).

- [ ] **Step 3: Implémenter dans `cronRegistry.ts`**

Dans `SchedulerRuntime`, après `onConfirmation` :

```ts
  /** Tick global du rappel avant le match (ADR-036) — un seul pour toutes les règles. */
  onStartReminderTick: (now: Date) => Promise<void>;
```

Après `let runtime: SchedulerRuntime | null = null;` :

```ts
/** Tick global du rappel avant le match : hors registre par règle, donc conservé par reloadScheduler. */
const START_REMINDER_TICK_CRON = "* * * * *";
let startReminderTask: Stoppable | null = null;

function stopStartReminderTick(): void {
  startReminderTask?.stop();
  startReminderTask = null;
}
```

Dans `startCronRegistry`, à la fin (après la boucle `scheduleOne`) :

```ts
  stopStartReminderTick();
  startReminderTask = cron.schedule(
    START_REMINDER_TICK_CRON,
    () => {
      void rt.onStartReminderTick(new Date()).catch((err) => {
        console.error("[scheduler] tick rappel avant match échec :", err);
      });
    },
    { timezone: TIMEZONE },
  );
```

Dans `__resetCronRegistryForTests`, ajouter `stopStartReminderTick();` avant `runtime = null;`.

`reloadScheduler` ne change pas.

- [ ] **Step 4: Brancher dans `scheduler.ts`** (`scheduleBookingRules`, l.162-169) :

```ts
  startCronRegistry(rules, {
    graph,
    telegram,
    db,
    onPoll: (rule) => triggerCronSendPoll(rule, graph, telegram, db),
    onDecision: (rule) => triggerCronDecision(rule, graph, telegram, db),
    onConfirmation: (rule) => triggerBookingConfirmation(rule, graph, telegram, db, huddleBot, resaSquash),
    onStartReminderTick: (now) => triggerStartReminders(now, graph, telegram, db, huddleBot, resaSquash),
  });
```

- [ ] **Step 5: Vérifier**

Run: `npm run worker:test && npm run typecheck`
Expected: PASS (tous les tests du worker).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/scheduler/cronRegistry.ts apps/worker/src/scheduler/cronRegistry.test.ts apps/worker/src/scheduler/scheduler.ts
git commit -m "feat(worker): tick global du rappel avant le match

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: API et étape 6 dans la page du job

**Files:**
- Modify: `apps/worker/src/http/server.ts` (imports l.8 et l.16-26, `handleJobStatus` l.352-370)
- Modify: `apps/ui/src/lib/worker.ts` (après `JobRun` ~l.104, `JobWithStatus` l.106-109)
- Modify: `apps/ui/src/app/rules/[id]/jobs/[jobId]/page.tsx`
- Modify: `apps/ui/src/app/rules/[id]/jobs/[jobId]/Pipeline.tsx` (types ~l.27, `step5State` ~l.107, props ~l.196-220, rendu ~l.591-604)

**Interfaces:**
- Consumes: `evaluateStartReminder` (Task 3), `findActiveJobRunForDate`.
- Produces: réponse JSON `{ job, status, startReminder: { state, plannedAt?, reason? } }` ; type UI `StartReminderInfo`.

- [ ] **Step 1: Worker — `handleJobStatus`**

Imports :

```ts
import { cancelJobRun, createJobRun, findActiveJobRunForDate, getJobRunById, listJobRuns, updateJobRunSchedule } from "../jobRuns.js";
import { evaluateStartReminder } from "../scheduler/startReminder.js";
```

Fin de `handleJobStatus` :

```ts
  const status = await getJobExecutionStatus(rule, job, deps.graph);
  const activeJob = await findActiveJobRunForDate(deps.db, rule.id, job.targetDate);
  const startReminder = evaluateStartReminder({
    rule,
    job,
    isActiveJobForDate: activeJob?.id === job.id,
    status,
    now: new Date(),
  });
  sendJson(res, 200, { job, status, startReminder });
```

- [ ] **Step 2: UI — types** (`apps/ui/src/lib/worker.ts`)

```ts
/** État du rappel avant le match calculé par le worker (`evaluateStartReminder`, ADR-036) — l'UI n'en recalcule rien. */
export interface StartReminderInfo {
  state: "disabled" | "skipped" | "waiting" | "due" | "sent" | "missed";
  /** Heure d'envoi prévue, ex. « 16h45 » (Paris). */
  plannedAt?: string;
  reason?: string;
}

export interface JobWithStatus {
  job: JobRun;
  status: RuleExecutionStatus;
  /** Présent sur `getJob` (route status) uniquement, pas sur `listJobs`. */
  startReminder?: StartReminderInfo;
}
```

- [ ] **Step 3: UI — `Pipeline.tsx`**

Import : `import type { StartReminderInfo } from "../../../../../lib/worker";` (même chemin relatif que les autres imports `lib/worker` du fichier — reprendre celui déjà utilisé pour `PollTally`).

Après `step5State` :

```ts
/** Rappel avant le match (ADR-036) : état calculé par le worker, affiché tel quel. */
function step6State(reminder: StartReminderInfo | undefined): StepState {
  if (reminder?.state === "sent") return "done";
  if (reminder?.state === "waiting" || reminder?.state === "due") return "current";
  return "pending";
}

function StartReminderStep({ reminder, sentAt }: { reminder?: StartReminderInfo; sentAt?: Date }) {
  return (
    <div className={stepClass(step6State(reminder))}>
      <h3>6. Rappel avant le match</h3>
      {!reminder && <p className="muted">Non activé pour cette règle.</p>}
      {reminder?.state === "disabled" && <p className="muted">{reminder.reason ? `${reminder.reason}.` : "—"}</p>}
      {(reminder?.state === "waiting" || reminder?.state === "due") && (
        <p className="muted">
          {reminder.state === "due"
            ? "Envoi imminent, dans le groupe de confirmation."
            : reminder.plannedAt
              ? `Prévu vers ${reminder.plannedAt} (±10 min), dans le groupe de confirmation.`
              : `${reminder.reason}.`}
        </p>
      )}
      {reminder?.state === "sent" && <p className="muted">✓ Envoyé{sentAt ? ` le ${formatDateTimeParis(sentAt)}` : ""}.</p>}
      {reminder?.state === "skipped" && <p className="muted">Non envoyé : {reminder.reason}.</p>}
      {reminder?.state === "missed" && <p className="muted">Non envoyé (créneau commencé).</p>}
    </div>
  );
}
```

Props de `Pipeline` : ajouter `startReminder,` et `startReminderSentAt,` à la déstructuration, et au type :

```ts
  startReminder?: StartReminderInfo;
  startReminderSentAt?: Date;
```

Rendu : après le `</div>` de l'étape 5 (avant le `</div>` final du conteneur) :

```tsx
      <div className="pipeline-arrow">→</div>

      <StartReminderStep reminder={startReminder} sentAt={startReminderSentAt} />
```

- [ ] **Step 4: UI — `page.tsx`**

```ts
  const { job, status, startReminder } = await getJob(id, jobId).catch(() => ({ job: undefined, status: undefined, startReminder: undefined }));
```

Remplacer la requête du select `jobRuns` :

```ts
    db
      .select({ sentAt: jobRuns.nextDayReminderSentAt, startReminderSentAt: jobRuns.startReminderSentAt })
      .from(jobRuns)
      .where(eq(jobRuns.id, jobId)),
```

Et passer à `<Pipeline …>` :

```tsx
        startReminder={startReminder}
        startReminderSentAt={jobReminder?.startReminderSentAt ?? undefined}
```

- [ ] **Step 5: Vérifier**

Run: `(cd packages/db && npm run build) && npm run typecheck && npm test`
Expected: PASS.

Note : `Pipeline` s'arrête plus tôt pour un job annulé (`if (job.cancelledAt) return …`) — le motif « job annulé » n'est donc jamais affiché dans l'étape 6 ; il reste utile côté worker. Ne pas modifier ce retour anticipé. La vérification visuelle de l'étape 6 se fait en fin de Task 7 (le réglage n'existe qu'à partir de là).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/http/server.ts apps/ui/src/lib/worker.ts "apps/ui/src/app/rules/[id]/jobs/[jobId]/page.tsx" "apps/ui/src/app/rules/[id]/jobs/[jobId]/Pipeline.tsx"
git commit -m "feat(ui): étape 6 « Rappel avant le match » sur la page du job

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Formulaire de règle et description générée

**Files:**
- Create: `apps/ui/src/lib/startReminderForm.ts`, `apps/ui/src/lib/startReminderForm.test.ts`
- Modify: `apps/ui/src/app/actions.ts` (`upsertRuleAction` ~l.142-210)
- Modify: `apps/ui/src/app/rules/RuleForm.tsx` (après la case `nextDayReminderEnabled` ~l.208-214)
- Modify: `packages/db/src/ruleDescription.ts` (tableau `lines` ~l.62-104), `packages/db/src/ruleDescription.test.ts`

**Interfaces:**
- Produces: `START_REMINDER_MIN_MINUTES = 30`, `START_REMINDER_MAX_MINUTES = 360`, `START_REMINDER_DEFAULT_MINUTES = 120`, `parseStartReminderMinutes(formData: FormData): number` (lève une `Error` hors bornes).

- [ ] **Step 1: Tests du parsing**

```ts
import { describe, expect, it } from "vitest";
import { parseStartReminderMinutes } from "./startReminderForm";

function form(value?: string): FormData {
  const f = new FormData();
  if (value !== undefined) f.set("startReminderMinutesBefore", value);
  return f;
}

describe("parseStartReminderMinutes", () => {
  it("valeur absente ou vide → 120", () => {
    expect(parseStartReminderMinutes(form())).toBe(120);
    expect(parseStartReminderMinutes(form(""))).toBe(120);
  });
  it("bornes incluses", () => {
    expect(parseStartReminderMinutes(form("30"))).toBe(30);
    expect(parseStartReminderMinutes(form("360"))).toBe(360);
  });
  it("hors bornes ou non entier → erreur explicite, pas de correction silencieuse", () => {
    for (const bad of ["29", "361", "90.5", "abc"]) {
      expect(() => parseStartReminderMinutes(form(bad))).toThrow(
        "Rappel avant le match : le délai doit être un nombre entier de minutes entre 30 et 360.",
      );
    }
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npm --workspace @squash-assistant/ui test -- startReminderForm.test.ts`
Expected: FAIL « Cannot find module './startReminderForm' ».

- [ ] **Step 3: Implémenter `startReminderForm.ts`**

```ts
export const START_REMINDER_MIN_MINUTES = 30;
export const START_REMINDER_MAX_MINUTES = 360;
export const START_REMINDER_DEFAULT_MINUTES = 120;

/** Délai du rappel avant le match (minutes) lu dans le formulaire de règle — refuse hors bornes au lieu de corriger. */
export function parseStartReminderMinutes(formData: FormData): number {
  const raw = String(formData.get("startReminderMinutesBefore") ?? "").trim();
  if (raw === "") return START_REMINDER_DEFAULT_MINUTES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < START_REMINDER_MIN_MINUTES || value > START_REMINDER_MAX_MINUTES) {
    throw new Error(
      `Rappel avant le match : le délai doit être un nombre entier de minutes entre ${START_REMINDER_MIN_MINUTES} et ${START_REMINDER_MAX_MINUTES}.`,
    );
  }
  return value;
}
```

- [ ] **Step 4: `actions.ts`** — import `import { parseStartReminderMinutes } from "../lib/startReminderForm";` (même style de chemin que l'import existant de `parseNotifyGroup`), puis dans `values`, après `nextDayReminderEnabled` :

```ts
    startReminderEnabled: formData.get("startReminderEnabled") === "on",
    startReminderMinutesBefore: parseStartReminderMinutes(formData),
```

- [ ] **Step 5: `RuleForm.tsx`** — après le `</label>` de la case `nextDayReminderEnabled` et **avant** `<ReservationNotifyGroupField … confirmation …>` :

```tsx
        <label>
          <input
            type="checkbox"
            name="startReminderEnabled"
            defaultChecked={source?.startReminderEnabled ?? false}
          />{" "}
          Rappel avant le match
        </label>
        <label>
          Minutes avant le premier créneau réservé
          <input
            type="number"
            name="startReminderMinutesBefore"
            defaultValue={source?.startReminderMinutesBefore ?? 120}
            min={30}
            max={360}
            step={1}
          />
        </label>
        <p className="muted">
          Le jour du match, même contenu que la confirmation (avec les QR en réservation réelle), envoyé dans le groupe de
          confirmation ci-dessous, à ±10 min près. Inactif si la décision a lieu le jour du match.
        </p>
```

- [ ] **Step 6: Tests de la description** — ajouter dans `ruleDescription.test.ts` :

```ts
  it("rappel avant le match activé : phrase avec le délai et le groupe de confirmation", () => {
    const text = describeRuleInFrench({ ...REAL_RULES["squashacademie-mardi"]!, startReminderEnabled: true, startReminderMinutesBefore: 120 });
    const sentence = text.split("\n").find((l) => l.startsWith("Le jour du match"))!;
    expect(sentence).toContain("2 h avant le premier créneau réservé");
    expect(sentence).toContain("±10 minutes");
    expect(sentence).toContain("même groupe que la confirmation");
  });

  it("rappel avant le match : 90 min → « 1 h 30 », 45 min → « 45 min »", () => {
    const base = REAL_RULES["squashacademie-mardi"]!;
    expect(describeRuleInFrench({ ...base, startReminderEnabled: true, startReminderMinutesBefore: 90 })).toContain("1 h 30 avant");
    expect(describeRuleInFrench({ ...base, startReminderEnabled: true, startReminderMinutesBefore: 45 })).toContain("45 min avant");
  });

  it("rappel activé mais décision le jour du match : signalé inactif", () => {
    const text = describeRuleInFrench({ ...REAL_RULES["squashacademie-mardi"]!, startReminderEnabled: true, decisionDaysBefore: 0 });
    expect(text).toContain("Le rappel avant le match est activé mais inactif : la décision a lieu le jour du match.");
  });

  it("rappel désactivé : aucune phrase", () => {
    const text = describeRuleInFrench({ ...REAL_RULES["squashacademie-mardi"]!, startReminderEnabled: false });
    expect(text).not.toContain("Le jour du match");
    expect(text).not.toContain("rappel avant le match");
  });
```

Run: `npm --workspace @squash-assistant/db test -- ruleDescription.test.ts`
Expected: FAIL sur les 3 premiers.

- [ ] **Step 7: Implémenter dans `ruleDescription.ts`**

Avant `describeRuleInFrench` (ou près des autres helpers) :

```ts
/** 120 → « 2 h », 90 → « 1 h 30 », 45 → « 45 min ». */
function formatReminderDelay(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")}`;
}
```

Dans `lines`, juste après la phrase « La confirmation WhatsApp des réservations … » :

```ts
    rule.startReminderEnabled
      ? rule.decisionDaysBefore === 0
        ? "Le rappel avant le match est activé mais inactif : la décision a lieu le jour du match."
        : `Le jour du match, un rappel WhatsApp (même contenu que la confirmation, avec les QR en réservation réelle) est envoyé ${formatReminderDelay(rule.startReminderMinutesBefore)} avant le premier créneau réservé, à ±10 minutes près, dans le même groupe que la confirmation.`
      : null,
```

Remplacer le `return lines.join("\n\n");` par :

```ts
  return lines.filter((line): line is string => line !== null).join("\n\n");
```

Remarque hors périmètre (spec) : la phrase de la confirmation reste affichée même quand `nextDayReminderEnabled` est faux — **ne pas** la modifier ici.

- [ ] **Step 8: Vérifier**

Run: `(cd packages/db && npm run build) && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 9: Vérification visuelle (étapes 6 et formulaire)** — lancer `npm run worker:dev` et `npm run ui:dev` (Postgres + Redis via docker-compose, `.env` présent). Sur une règle : cocher « Rappel avant le match », saisir 400 → erreur explicite ; saisir 90 → enregistré, description générée « 1 h 30 avant ». Ouvrir un job annoncé de cette règle : l'étape 6 affiche « Prévu vers … (±10 min) » ou le motif attendu ; sur une règle sans rappel : « Non activé pour cette règle. ». Si l'environnement local n'est pas disponible, le noter dans le compte rendu au lieu de l'affirmer.

- [ ] **Step 10: Commit**

```bash
git add apps/ui/src/lib/startReminderForm.ts apps/ui/src/lib/startReminderForm.test.ts apps/ui/src/app/actions.ts apps/ui/src/app/rules/RuleForm.tsx packages/db/src/ruleDescription.ts packages/db/src/ruleDescription.test.ts
git commit -m "feat(ui): réglage du rappel avant le match dans le formulaire de règle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation, ADR et vérification finale

**Files:**
- Create: `docs/adr/ADR-036-rappel-avant-match-tick-global.md`
- Modify: `docs/adr/README.md` (tableau, après la ligne 035 ~l.47)
- Modify: `docs/spec/regles-fonctionnelles.md` (§6, après le bloc « Confirmation WhatsApp des réservations » ~l.151-154 ; tableau « Historique des décisions notables » ~l.218)

- [ ] **Step 1: Écrire l'ADR-036**

```markdown
# ADR-036 – Rappel WhatsApp avant le match, déclenché par un tick global

**Status:** accepted
**Date:** 2026-10-05
**Spec:** [2026-10-05-rappel-avant-match-design.md](../superpowers/specs/2026-10-05-rappel-avant-match-design.md)

## Contexte

La confirmation WhatsApp (étape 5, ADR-033/035) part le jour de la décision. Jusqu'à 5 jours la séparent du match : les joueurs oublient terrain, heure et partenaires, et n'ont plus de QR valide. Il faut un rappel le jour même, X minutes (défaut 120, ±10) avant le premier créneau réellement réservé. Cette heure dépend des créneaux pris chaque semaine : aucun cron fixe par règle ne peut la porter.

## Décision

1. **Tick global `* * * * *` (Europe/Paris)**, créé une seule fois dans `startCronRegistry`, hors registre par règle (conservé par `reloadScheduler`). À chaque tick, `triggerStartReminders` lit les règles avec rappel activé, le job actif du jour (`findActiveJobRunForDate`), puis l'état LangGraph de ce seul job.
2. **Décision pure** `evaluateStartReminder` (états `disabled/skipped/waiting/due/sent/missed`, priorité fixe), partagée avec l'API status de l'UI (étape 6) — l'UI ne recalcule rien.
3. **Heure en minutes, heure murale de Paris** (`Intl`) : l'heuristique « +02:00 d'avril à octobre » est fausse après le passage à l'heure d'hiver et décalait le rappel d'une heure.
4. **Décalage ±10 min dérivé d'un hash de l'id du job** (FNV-1a) : stable d'un tick à l'autre et après redémarrage, rien à stocker.
5. **Réservation atomique avant envoi** (`UPDATE job_runs SET start_reminder_sent_at … WHERE … IS NULL RETURNING`) ; remise à `NULL` si `sendMessage` échoue, nouvel essai chaque minute jusqu'au premier créneau. Au plus un message par job, y compris en déploiement progressif. Limites assumées : un timeout ambigu de `sendMessage` peut doubler le message ; un pod tué entre réservation et envoi perd le rappel.
6. **Règle live pour les réglages** (activation, délai, destinataire, `decisionDaysBefore`) ; **règle figée du job** (`status.values.bookingRule`, repli `job.ruleSnapshot`) pour le contenu du message. Écart volontaire avec la confirmation, qui passe la règle live au constructeur de message.
7. Pas de rappel si `decisionDaysBefore = 0` ; en dry-run, pas de rappel vers le groupe du sondage.

## Alternatives écartées

- `setTimeout` posé à la fin de l'étape 4 : perdu au redémarrage du pod (jusqu'à 5 jours d'attente), reprise au boot et annulation à l'édition de la règle à écrire.
- Cron par règle à heure fixe : l'heure du premier créneau change d'une semaine à l'autre.

## Conséquences

- Migration `0032` : `booking_rules.start_reminder_enabled` (défaut `false`), `booking_rules.start_reminder_minutes_before` (défaut 120), `job_runs.start_reminder_sent_at`. Appliquée par l'initContainer (ADR-012).
- Une requête par minute (plus une par règle éligible) ; Redis seulement pour 0 à 2 jobs par jour.
- `START_REMINDER_SINCE` : les jobs créés avant la mise en production affichent « — » à l'étape 6, jamais « non envoyé ».
```

- [ ] **Step 2: Index des ADR** — ajouter après la ligne 035 :

```markdown
| [036](./ADR-036-rappel-avant-match-tick-global.md) | Rappel WhatsApp le jour du match, X min (±10) avant le premier créneau réservé, via un tick global et une réservation atomique avant envoi | accepted |
```

- [ ] **Step 3: Règles fonctionnelles** — dans §6, après les puces de la confirmation WhatsApp, ajouter :

```markdown
- **Rappel avant le match (2026-10-05, ADR-036 ; `BookingRule.startReminderEnabled`, défaut false ; `startReminderMinutesBefore`, défaut 120, bornes 30–360)** : le **jour du match**, un rappel WhatsApp part `startReminderMinutesBefore` minutes avant le **premier créneau réellement réservé** du job (créneaux refusés et hors fenêtre exclus), à ±10 min près (décalage fixe par job). Un seul rappel par job, même s'il y a plusieurs heures de début. Contenu : celui de la confirmation (date, courts fusionnés, « Oui au sondage ») avec le titre « ⏰ Rappel — Squash aujourd'hui (<jour>) », et des QR neufs en réservation réelle. Destinataire : le **groupe de confirmation** (`confirmationNotifyWhatsappGroupJid`, sinon groupe du sondage), lu sur la règle live.
  - Envoyé seulement pour le job actif de la date, `finished-announced`, avec au moins un créneau réservé, et tant que le premier créneau n'a pas commencé (rattrapage après redémarrage, jamais d'envoi tardif).
  - **Pas de rappel** si la décision a lieu le jour du match (`decisionDaysBefore = 0`). **Dry-run** : pas de rappel vers le groupe du sondage ; vers un autre groupe, titre « ⏰ Rappel (dry-run — aucun court réservé) », sans QR.
  - Un job déjà annoncé garde son rappel même si une fermeture du club est déclarée ensuite (les réservations TeamR restent).
  - Échec d'envoi WhatsApp : un log Telegram par job, nouvel essai chaque minute jusqu'au premier créneau. Job resté bloqué avant l'annonce le jour du match : un log Telegram (pas de log pour un job terminé sans annonce : rien à réserver, pas de go, club fermé).
  - Page du job : **étape 6 « Rappel avant le match »** — « Non activé pour cette règle », « En attente de l'annonce (étape 4) » (match à venir), « Prévu vers 16h45 (±10 min) », « Envoi imminent », « ✓ Envoyé le … », « Non envoyé : <motif> » (décision le jour du match, job annulé, pas le job actif de cette date, job non annoncé, aucun créneau réservé, dry-run vers le groupe d'origine), « Non envoyé (créneau commencé) », ou « — » pour un job créé avant la fonctionnalité.
  - Formulaire de règle : case « Rappel avant le match » et champ « Minutes avant le premier créneau réservé » (refus explicite hors 30–360). La description générée mentionne le rappel seulement s'il est activé.
```

Dans « Historique des décisions notables », ajouter en tête du tableau :

```markdown
| 2026-10-05 | Rappel WhatsApp le jour du match, 2 h (réglable) ±10 min avant le premier créneau réservé, même contenu que la confirmation, dans le groupe de confirmation ; pas de rappel si décision le jour du match ni en dry-run vers le groupe d'origine (ADR-036) | Jusqu'à 5 jours séparent la confirmation (jour de la décision) du match : on oublie terrain, heure et partenaires |
```

- [ ] **Step 4: Vérification finale**

Run:
```bash
(cd packages/db && npm run build)
npm run typecheck
npm test
graphify update .
```
Expected: typecheck et tests PASS ; `graphify update` sans erreur.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/ADR-036-rappel-avant-match-tick-global.md docs/adr/README.md docs/spec/regles-fonctionnelles.md
git commit -m "docs: ADR-036 et règles fonctionnelles du rappel avant le match

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`graphify-out/` est ignoré par git : ne pas l'ajouter.)

---

## Après le plan

- `START_REMINDER_SINCE` vaut `2026-10-06T00:00:00Z` : si la mise en production a lieu plus tard, l'ajuster à la date réelle dans le commit de release (les jobs créés entre-temps n'auraient pas de rappel, sans autre effet).
- Premier test réel : cocher le rappel sur une règle dont la confirmation part vers le groupe de test, vérifier l'étape 6 puis le message le jour du match.
