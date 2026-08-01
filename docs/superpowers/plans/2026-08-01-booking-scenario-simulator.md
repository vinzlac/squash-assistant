# Simulateur de scénarios de réservation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter une section de l'UI d'administration permettant de créer des scénarios de vote (joueurs + oui/non/prête-nom) par règle, calculer le plan de réservation via le vrai moteur local avec une disponibilité synthétique "tout libre", valider/invalider le résultat, verrouiller la règle associée tant qu'un scénario la référence, et exporter les scénarios validés vers une suite de tests de non-régression versionnée.

**Architecture:** Nouvelle table `scenarios` (Postgres, FK vers `booking_rules`). Le CRUD des scénarios (comme celui des règles) est fait en accès DB direct depuis `apps/ui` (Next.js Server Actions, pas de détour par le worker). Seul le calcul du plan simulé nécessite le worker (le moteur `computeGroupBookingPlan` y vit) : un nouvel endpoint HTTP interne `POST /rules/:id/scenarios/:scenarioId/simulate` calcule et persiste le plan. La boucle multi-heures candidates de `bookSlots.ts` (threading `usedSessionIds`/`existingDailyCounts`/`usedTodayIds`) est d'abord extraite dans un module pur partagé (`planning/planJob.ts`), réutilisé à l'identique par le nœud réel et par le simulateur — garantit que le simulateur exerce le code de production, pas une copie.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), Next.js 16 App Router (Server Actions), Vitest.

## Global Constraints

- Aucun appel MCP réel (huddle-bot, resa-squash) pendant le calcul d'un plan simulé — seule `getGroupMemberNames` (déjà existant) est utilisée à l'édition d'un scénario, pas à chaque calcul.
- Le compteur de plafond de résas/jour (`existingDailyCounts`) démarre toujours à `{}` (vide) dans le simulateur — pas de configuration d'un compteur de départ non nul (décision du 2026-08-01).
- La règle (`BookingRule`) est en lecture seule depuis le simulateur — seuls les joueurs/votes du scénario sont éditables.
- Une règle référencée par au moins un scénario ne peut plus être modifiée (double garde : UI + serveur) tant que ses scénarios n'ont pas été supprimés.
- L'export est un téléchargement JSON — pas d'écriture directe dans le repo git depuis un pod (UI/worker n'ont pas de checkout du repo en prod).
- Toute nouvelle table suit le pattern Drizzle existant (`packages/db/src/schema.ts`) : migration générée via `npm run db:generate` dans `packages/db`, jamais écrite à la main.
- `apps/worker` : `npm test` (vitest) et `npx tsc -p tsconfig.build.json` doivent rester verts après chaque tâche touchant ce package.
- `apps/ui` : `npm run typecheck` et `npm run build` doivent rester verts après chaque tâche touchant ce package.

---

## File Structure

| Fichier | Statut | Rôle |
|---|---|---|
| `packages/db/src/schema.ts` | Modifié | Ajoute la table `scenarios` + relation vers `booking_rules` |
| `packages/db/src/migrations/00XX_*.sql` | Créé (généré) | Migration Drizzle pour `scenarios` |
| `apps/worker/src/planning/planJob.ts` | Créé | Boucle pure multi-heures candidates, extraite de `bookSlots.ts` (partagée nœud réel / simulateur) |
| `apps/worker/src/graph/nodes/bookSlots.ts` | Modifié | Appelle `planJobBookings` au lieu de sa propre boucle |
| `apps/worker/src/planning/simulateScenario.ts` | Créé | Disponibilité synthétique + dérivation des votes + appel à `planJobBookings` |
| `apps/worker/src/planning/simulateScenario.test.ts` | Créé | Tests unitaires de `simulateScenario` |
| `apps/worker/src/scenarios.ts` | Créé | Lecture d'un scénario + persistance du plan calculé (utilisé par l'endpoint HTTP) |
| `apps/worker/src/http/server.ts` | Modifié | Ajoute la route `POST /rules/:id/scenarios/:scenarioId/simulate` |
| `apps/worker/src/planning/__fixtures__/scenarios/` | Créé (vide au départ) | Fixtures JSON exportées, un fichier par scénario validé |
| `apps/worker/src/planning/scenarios.regression.test.ts` | Créé | Rejoue chaque fixture et vérifie l'égalité avec le plan attendu |
| `apps/ui/src/lib/scenarios.ts` | Créé | CRUD direct DB des scénarios (`getDb()`, comme `booking_rules`) |
| `apps/ui/src/lib/worker.ts` | Modifié | Ajoute `simulateScenario(ruleId, scenarioId)` (appel HTTP au worker) |
| `apps/ui/src/app/actions.ts` | Modifié | Server actions scénarios + garde de verrouillage dans `upsertRuleAction` |
| `apps/ui/src/app/rules/[id]/simulator/page.tsx` | Créé | Liste des scénarios d'une règle |
| `apps/ui/src/app/rules/[id]/simulator/[scenarioId]/page.tsx` | Créé | Édition d'un scénario (page serveur, charge les données) |
| `apps/ui/src/app/rules/[id]/simulator/[scenarioId]/ScenarioEditor.tsx` | Créé | Formulaire client (joueurs/votes/titulaire/plan/validation/export) |
| `apps/ui/src/app/rules/[id]/edit/page.tsx` | Modifié | Affiche un message de verrouillage au lieu du formulaire si des scénarios existent |
| `docs/spec/regles-fonctionnelles.md` | Modifié | Documente le simulateur |
| `docs/adr/ADR-019-simulateur-scenarios-reservation.md` | Créé | Décision d'architecture (table `scenarios`, réutilisation du moteur, verrouillage) |

---

### Task 1: Table `scenarios` (schéma + migration)

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create (généré) : `packages/db/src/migrations/00XX_scenarios.sql`

**Interfaces:**
- Produces: `scenarios` (table Drizzle), `Scenario` (type `typeof scenarios.$inferSelect`), `ScenarioPlayer` (interface `{ playerId: string; name: string; vote: string }`), `scenariosRelations`.

- [ ] **Step 1: Ajouter le type et la table dans `packages/db/src/schema.ts`**

Ajouter après le bloc `bookingRuleHistory` (avant `jobRuns`) :

```ts
// ─── Scenarios (simulateur de réservation) ──────────────────────────────────
// Un scénario associe un jeu de joueurs (avec leur vote) à UNE règle donnée,
// pour calculer un plan de réservation avec une disponibilité synthétique
// "tout libre" — voir docs/adr/ADR-019 et docs/superpowers/specs/2026-08-01-*.
export interface ScenarioPlayer {
  playerId: string;
  /** Dénormalisé au moment de l'ajout — affichage sans re-résolution. */
  name: string;
  /** Une heure candidate de la règle (ex. "18H45"), "prete-nom", ou "non". Mutuellement exclusif. */
  vote: string;
}

export const scenarios = pgTable("scenarios", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingRuleId: text("booking_rule_id")
    .notNull()
    .references(() => bookingRules.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  players: jsonb("players").notNull().default([]).$type<ScenarioPlayer[]>(),
  /** userId du joueur jouant le rôle du titulaire (exempté de plafond de résas/jour) — null si aucun. */
  apiUserId: text("api_user_id"),
  /** null = non évalué, true = plan OK (exportable), false = plan pas OK. */
  validated: boolean("validated"),
  /** Dernier plan calculé (BookingPlanGroup[]) — évite un recalcul à l'ouverture du scénario. */
  lastPlan: jsonb("last_plan"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdateFn(() => new Date()),
});

export type Scenario = typeof scenarios.$inferSelect;

export const scenariosRelations = relations(scenarios, ({ one }) => ({
  bookingRule: one(bookingRules, { fields: [scenarios.bookingRuleId], references: [bookingRules.id] }),
}));
```

Puis ajouter `scenarios: many(scenarios)` dans `bookingRulesRelations` (juste après `history: many(bookingRuleHistory)`).

- [ ] **Step 2: Générer la migration**

```bash
cd packages/db
npm run db:generate
```

Vérifier que le fichier généré dans `src/migrations/` contient un `CREATE TABLE "scenarios"` avec les colonnes attendues et la contrainte `ON DELETE CASCADE` sur `booking_rule_id`.

- [ ] **Step 3: Vérifier que le package `db` compile**

```bash
npm run build --workspace=packages/db
```

Expected: pas d'erreur TypeScript.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/migrations/
git commit -m "feat(db): table scenarios pour le simulateur de réservation"
```

---

### Task 2: Extraire `planJobBookings` de `bookSlots.ts`

**Files:**
- Create: `apps/worker/src/planning/planJob.ts`
- Modify: `apps/worker/src/graph/nodes/bookSlots.ts`
- Test (existant, ne doit pas changer de comportement) : `apps/worker/src/graph/nodes/bookSlots.test.ts`

**Interfaces:**
- Produces: `planJobBookings(bookingRule: BookingRule, targetDate: string, confirmedPlayerIdsByTime: Record<string, string[]>, volunteerSubstituteIds: string[], availableSlots: AvailableSlot[], apiUserId: string | null): BookingPlanGroup[]`
- Consumes (déjà existant) : `computeGroupBookingPlan` (`planning/groupBookingPlan.ts`), `buildGroupBookingPlanParams` (`graph/buildGroupBookingPlanParams.ts`), `computeShortfall`/`splitByAvailabilityWindow` (`graph/capacityPlanning.ts`), `BookingPlanGroup` (`graph/state.ts`).

C'est un refactor à comportement strictement inchangé — le filet de sécurité est `bookSlots.test.ts`, qui doit rester vert avant/après sans aucune modification de son contenu.

- [ ] **Step 1: Vérifier que le test existant est vert avant de toucher au code**

```bash
cd apps/worker
npm test -- bookSlots.test.ts
```

Expected: `PASS`, tous les tests verts (état de référence avant refactor).

- [ ] **Step 2: Créer `apps/worker/src/planning/planJob.ts`**

Déplacer telles quelles les fonctions `notEnoughPlayersPlan`, `planWithEscalation`, `substitutesUsedInPlan` depuis `bookSlots.ts`, et ajouter `planJobBookings` :

```ts
import { buildGroupBookingPlanParams } from "../graph/buildGroupBookingPlanParams.js";
import { computeShortfall, splitByAvailabilityWindow } from "../graph/capacityPlanning.js";
import type { BookingPlanGroup } from "../graph/state.js";
import type { BookingRule } from "../config.js";
import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import { computeGroupBookingPlan, type ComputeGroupBookingPlanInput } from "./groupBookingPlan.js";
import type { AvailableSlot } from "./courtAssignment.js";

function notEnoughPlayersPlan(
  bookingRule: BookingRule,
  targetDate: string,
  startTime: string,
  confirmedPlayerIds: string[],
): GroupBookingPlan {
  return {
    dryRun: true,
    proposedBookings: [],
    warnings: [
      `Pas assez de joueurs confirmés à ${startTime} (${confirmedPlayerIds.length}/${bookingRule.minPlayersPerCourt} requis) pour proposer un créneau.`,
    ],
    meta: {
      courtsNeeded: 0,
      roundsPlanned: 0,
      dryRun: true,
      groupLabel: bookingRule.id,
      recurringWeekday: new Date(targetDate).getDay(),
      recurringStartTime: startTime,
      slotsPerPlayer: 0,
      groupMinSlotsPerPlayer: 0,
      groupMaxSlotsPerPlayer: 0,
      pairCount: 0,
    },
  };
}

/**
 * Calcule le plan pour une heure candidate, avec escalade automatique min→max joueurs/court
 * si la 1ère tentative ne suffit pas (ADR-014) — même logique de retry qu'avant, mais sur le
 * moteur local au lieu d'un 2e appel MCP.
 */
function planWithEscalation(
  bookingRule: BookingRule,
  confirmedPlayerIds: string[],
  targetDate: string,
  startTime: string,
  usedTodayIds: ReadonlySet<string>,
  volunteerSubstituteIds: string[],
  availableSlots: AvailableSlot[],
  usedSessionIds: ReadonlySet<string>,
  apiUserId: string | null,
  existingDailyCounts: Readonly<Record<string, number>>,
): GroupBookingPlan {
  const params = buildGroupBookingPlanParams(
    bookingRule,
    confirmedPlayerIds,
    targetDate,
    startTime,
    undefined,
    usedTodayIds,
    volunteerSubstituteIds,
  );
  const input: ComputeGroupBookingPlanInput = { ...params, availableSlots, usedSessionIds, apiUserId, existingDailyCounts };
  const plan = computeGroupBookingPlan(input);

  if (!bookingRule.preferMinPlayersPerCourt || computeShortfall(plan) === 0) {
    return plan;
  }

  const escalatedParams = buildGroupBookingPlanParams(
    bookingRule,
    confirmedPlayerIds,
    targetDate,
    startTime,
    false,
    usedTodayIds,
    volunteerSubstituteIds,
  );
  const escalatedPlan = computeGroupBookingPlan({ ...escalatedParams, availableSlots, usedSessionIds, apiUserId, existingDailyCounts });
  return escalatedPlan.proposedBookings.length > plan.proposedBookings.length ? escalatedPlan : plan;
}

function substitutesUsedInPlan(
  rule: BookingRule,
  volunteerSubstituteIds: string[],
  plan: GroupBookingPlan,
  confirmedPlayerIds: string[],
): string[] {
  const confirmedSet = new Set(confirmedPlayerIds);
  const substituteSet = new Set([...volunteerSubstituteIds, ...rule.substituteBookers]);
  const used = new Set<string>();
  for (const b of plan.proposedBookings) {
    for (const id of [b.userId, b.partnerId]) {
      if (id && substituteSet.has(id) && !confirmedSet.has(id)) {
        used.add(id);
      }
    }
  }
  return [...used];
}

/**
 * Boucle sur les heures candidates d'une règle et calcule un plan par heure, en threadant
 * usedSessionIds (double-booking structurellement impossible entre heures, ADR-018) et
 * existingDailyCounts (plafond de résas/jour par joueur, cf. corrections du 2026-08-01) d'une
 * heure à l'autre. Fonction pure, aucun I/O — partagée entre le nœud réel (bookSlots.ts, qui
 * fournit availableSlots via list_availability) et le simulateur (simulateScenario.ts, qui
 * fournit une disponibilité synthétique).
 */
export function planJobBookings(
  bookingRule: BookingRule,
  targetDate: string,
  confirmedPlayerIdsByTime: Record<string, string[]>,
  volunteerSubstituteIds: string[],
  availableSlots: AvailableSlot[],
  apiUserId: string | null,
): BookingPlanGroup[] {
  const groups: BookingPlanGroup[] = [];
  const usedTodayIds = new Set<string>(Object.values(confirmedPlayerIdsByTime).flat());
  const usedSessionIds = new Set<string>();
  const playerDailyCounts = new Map<string, number>();

  for (const startTime of bookingRule.candidateStartTimes) {
    const confirmedPlayerIds = confirmedPlayerIdsByTime[startTime] ?? [];

    if (confirmedPlayerIds.length < bookingRule.minPlayersPerCourt) {
      groups.push({
        startTime,
        plan: notEnoughPlayersPlan(bookingRule, targetDate, startTime, confirmedPlayerIds),
        outOfWindowSessionIds: [],
      });
      continue;
    }

    const plan = planWithEscalation(
      bookingRule,
      confirmedPlayerIds,
      targetDate,
      startTime,
      usedTodayIds,
      volunteerSubstituteIds,
      availableSlots,
      usedSessionIds,
      apiUserId,
      Object.fromEntries(playerDailyCounts),
    );
    for (const id of substitutesUsedInPlan(bookingRule, volunteerSubstituteIds, plan, confirmedPlayerIds)) {
      usedTodayIds.add(id);
    }
    for (const b of plan.proposedBookings) {
      for (const id of [b.userId, b.partnerId]) {
        if (!id) continue;
        playerDailyCounts.set(id, (playerDailyCounts.get(id) ?? 0) + 1);
      }
    }
    const { outOfWindowSessionIds } = splitByAvailabilityWindow(plan, startTime, bookingRule.availabilityWindowHours);
    for (const b of plan.proposedBookings) {
      if (!outOfWindowSessionIds.includes(b.sessionId)) usedSessionIds.add(b.sessionId);
    }
    groups.push({ startTime, plan, outOfWindowSessionIds });
  }

  return groups;
}
```

- [ ] **Step 3: Réécrire `bookSlots.ts` pour appeler `planJobBookings`**

Remplacer tout le contenu de `apps/worker/src/graph/nodes/bookSlots.ts` par :

```ts
import { listAvailability, listMyReservationsOnDate, type AvailabilitySlot } from "../../mcp/resaSquash.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { withEventLogging } from "../emitEvent.js";
import { planJobBookings } from "../../planning/planJob.js";
import type { AvailableSlot } from "../../planning/courtAssignment.js";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

function toAvailableSlot(slot: AvailabilitySlot): AvailableSlot {
  return { sessionId: slot.id, court: slot.court, beginTime: slot.time, endTime: slot.endTime };
}

export function createBookSlotsNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate, confirmedPlayerIdsByTime, volunteerSubstituteIds } = state;

    const bookingPlanGroups = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "booking", targetDate },
      async () => {
        const { availability } = await listAvailability(deps.resaSquash.client, targetDate, targetDate);
        const availableSlots = availability.flatMap((day) => day.slots.filter((s) => s.available).map(toAvailableSlot));

        // Le titulaire de la clé API n'a lui-même aucun plafond de résas/jour — seul son userId
        // sert à l'exclure du contrôle de quota (voir ComputeGroupBookingPlanInput.apiUserId).
        const { userId: apiUserId } = await listMyReservationsOnDate(deps.resaSquash.client, targetDate);

        const groups = planJobBookings(bookingRule, targetDate, confirmedPlayerIdsByTime, volunteerSubstituteIds, availableSlots, apiUserId);
        return { result: groups, detail: { step: "plan-proposed", groups } };
      },
    );

    const capacityWarnings = bookingPlanGroups
      .map((g) => {
        const outOfWindowPlayers = countPlayersInSessions(g.plan, g.outOfWindowSessionIds);
        const shortfall = computeShortfall(g.plan) + outOfWindowPlayers;
        if (shortfall === 0) return null;
        return `⚠️ ${g.startTime} : ~${shortfall} joueur(s) risquent de ne pas avoir de créneau — voir le détail à l'étape 3.`;
      })
      .filter((w): w is string => w !== null);

    const summaryParts = bookingPlanGroups.map((g) =>
      g.plan.proposedBookings.length === 0
        ? `${g.startTime} : aucun créneau (${g.plan.warnings.join(" ")})`
        : `${g.startTime} :\n` +
          g.plan.proposedBookings
            .map(
              (b) =>
                `  • ${b.slotTime}-${b.slotEndTime} (court ${b.court}) — ${b.userId}${b.partnerId ? ` et ${b.partnerId}` : ""}` +
                (g.outOfWindowSessionIds.includes(b.sessionId) ? " [hors fenêtre, non réservé]" : ""),
            )
            .join("\n"),
    );
    const totalProposed = bookingPlanGroups.reduce((n, g) => n + g.plan.proposedBookings.length, 0);
    const warningsBlock = capacityWarnings.length > 0 ? `${capacityWarnings.join("\n")}\n\n` : "";
    const summary =
      totalProposed === 0
        ? `[${bookingRule.id}] Aucun créneau proposé pour le ${targetDate} (toutes heures confondues).\n${summaryParts.join("\n")}`
        : `[${bookingRule.id}] ${warningsBlock}Plan de réservation (dry-run) pour le ${targetDate} :\n${summaryParts.join("\n\n")}\n\nRéponds "go" pour confirmer.`;

    await sendTelegramMessage(deps.telegram, summary);

    return { bookingPlanGroups };
  };
}
```

Il manque l'import de `computeShortfall`/`countPlayersInSessions` (toujours utilisés par le résumé Telegram, pas par la boucle) — ajouter en haut du fichier :

```ts
import { computeShortfall, countPlayersInSessions } from "../capacityPlanning.js";
```

- [ ] **Step 4: Vérifier que `bookSlots.test.ts` est toujours vert (comportement inchangé)**

```bash
npm test -- bookSlots.test.ts
```

Expected: `PASS`, mêmes tests, aucune régression.

- [ ] **Step 5: Suite complète + typecheck**

```bash
npm test
npx tsc -p tsconfig.build.json
```

Expected: tous les tests verts (63+ avant ce refactor), `TypeScript: No errors found`.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/planning/planJob.ts apps/worker/src/graph/nodes/bookSlots.ts
git commit -m "refactor(worker): extrait planJobBookings de bookSlots.ts (partagé avec le simulateur)"
```

---

### Task 3: `simulateScenario` — disponibilité synthétique + dérivation des votes

**Files:**
- Create: `apps/worker/src/planning/simulateScenario.ts`
- Test: `apps/worker/src/planning/simulateScenario.test.ts`

**Interfaces:**
- Consumes: `planJobBookings` (Task 2), `SQUASH_COURT_COUNT`/`SQUASH_SLOT_MINUTES` (`planning/constants.ts`), `formatTeamrTimeFromMinutes`/`parseTeamrTime` (`planning/teamrTime.ts`), `BookingRule` (`config.ts`), `BookingPlanGroup` (`graph/state.ts`).
- Produces: `ScenarioPlayerVote` (interface `{ playerId: string; vote: string }`), `simulateScenario(rule: BookingRule, players: ScenarioPlayerVote[], apiUserId: string | null): BookingPlanGroup[]` (prend le `BookingRule` complet — Task 11 en extrait un sous-ensemble uniquement pour la fixture JSON, reconstitué en `BookingRule` complet avant l'appel).

- [ ] **Step 1: Write the failing test**

Créer `apps/worker/src/planning/simulateScenario.test.ts` :

```ts
import { describe, expect, it } from "vitest";
import { simulateScenario, type ScenarioPlayerVote } from "./simulateScenario.js";
import type { BookingRule } from "../config.js";

function rule(overrides: Partial<BookingRule> = {}): BookingRule {
  return {
    id: "squashacademie-mardi",
    name: null,
    enabled: true,
    whatsappGroupJid: "group@test",
    resaSquashGroupId: "group-1",
    pollCron: "0 10 * * 2",
    decisionCron: "30 21 * * 2",
    targetWeekdayOffset: 7,
    candidateStartTimes: ["18H45"],
    maxCourtsPerSlot: 3,
    minPlayersPerCourt: 2,
    maxPlayersPerCourt: 2,
    maxReservationsPerPlayer: 1,
    priorityBookers: [],
    preferMinPlayersPerCourt: false,
    courtPriority: [4, 3, 2, 1],
    availabilityWindowHours: 3,
    description: null,
    substituteBookers: [],
    maxDailyReservationsPerPlayer: 2,
    ...overrides,
  };
}

describe("simulateScenario", () => {
  it("2 joueurs votent la même heure candidate : 1 réservation, court libre choisi", () => {
    const players: ScenarioPlayerVote[] = [
      { playerId: "a", vote: "18H45" },
      { playerId: "b", vote: "18H45" },
    ];
    const groups = simulateScenario(rule(), players, null);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.startTime).toBe("18H45");
    expect(groups[0]!.plan.proposedBookings).toEqual([
      expect.objectContaining({ userId: "a", partnerId: "b", slotTime: "18H45" }),
    ]);
  });

  it("un joueur qui vote \"prete-nom\" n'est jamais confirmé lui-même, seulement disponible comme substitut", () => {
    const players: ScenarioPlayerVote[] = [
      { playerId: "a", vote: "18H45" },
      { playerId: "b", vote: "18H45" },
      { playerId: "c", vote: "prete-nom" },
    ];
    const groups = simulateScenario(rule(), players, null);
    const allIds = groups.flatMap((g) => g.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId]));
    expect(allIds).not.toContain("c");
  });

  it("un joueur qui vote \"non\" n'apparaît jamais dans le plan", () => {
    const players: ScenarioPlayerVote[] = [
      { playerId: "a", vote: "18H45" },
      { playerId: "b", vote: "18H45" },
      { playerId: "c", vote: "non" },
    ];
    const groups = simulateScenario(rule(), players, null);
    const allIds = groups.flatMap((g) => g.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId]));
    expect(allIds).not.toContain("c");
  });

  it("2 heures candidates, 4 joueurs : deux plans distincts, courts synthétiques disponibles sur les deux", () => {
    const players: ScenarioPlayerVote[] = [
      { playerId: "a", vote: "18H45" },
      { playerId: "b", vote: "18H45" },
      { playerId: "c", vote: "19H30" },
      { playerId: "d", vote: "19H30" },
    ];
    const groups = simulateScenario(rule({ candidateStartTimes: ["18H45", "19H30"] }), players, null);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.plan.proposedBookings).toHaveLength(1);
    expect(groups[1]!.plan.proposedBookings).toHaveLength(1);
  });

  it("le titulaire (apiUserId) n'est jamais substitué même en jouant plus que maxDailyReservationsPerPlayer", () => {
    // stephane (non-titulaire) atteint le plafond dès le round 3 : sans prête-nom disponible pour
    // le couvrir, sa réservation serait ignorée — d'où le vote "prete-nom" de sebastien, qui le
    // remplace. Sans ce 3e joueur, seuls 2 créneaux seraient produits (round 3 ignoré, warning
    // explicite), pas 3 — ce n'est pas le titulaire qui manquerait de prête-nom, lui n'a aucun
    // plafond, c'est stephane.
    const players: ScenarioPlayerVote[] = [
      { playerId: "vincent", vote: "18H45" },
      { playerId: "stephane", vote: "18H45" },
      { playerId: "sebastien", vote: "prete-nom" },
    ];
    const groups = simulateScenario(
      rule({ candidateStartTimes: ["18H45"], maxReservationsPerPlayer: 3, maxDailyReservationsPerPlayer: 2 }),
      players,
      "vincent",
    );
    const bookings = groups[0]!.plan.proposedBookings;
    expect(bookings).toHaveLength(3);
    expect(bookings.every((b) => b.userId === "vincent")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- simulateScenario.test.ts
```

Expected: FAIL — `Cannot find module './simulateScenario.js'`.

- [ ] **Step 3: Write minimal implementation**

Créer `apps/worker/src/planning/simulateScenario.ts` :

```ts
import { SQUASH_COURT_COUNT, SQUASH_SLOT_MINUTES } from "./constants.js";
import { formatTeamrTimeFromMinutes, parseTeamrTime } from "./teamrTime.js";
import { planJobBookings } from "./planJob.js";
import type { AvailableSlot } from "./courtAssignment.js";
import type { BookingRule } from "../config.js";
import type { BookingPlanGroup } from "../graph/state.js";

export interface ScenarioPlayerVote {
  playerId: string;
  /** Une heure candidate de la règle, "prete-nom", ou "non". */
  vote: string;
}

/** Date arbitraire fixe — jamais utilisée pour une vraie réservation (simulation uniquement). */
const SIMULATION_DATE = "2026-01-06";

function synthesizeAvailableSlots(candidateStartTimes: string[], maxReservationsPerPlayer: number): AvailableSlot[] {
  const slots: AvailableSlot[] = [];
  let seq = 0;
  for (const startTime of candidateStartTimes) {
    const startMinutes = parseTeamrTime(startTime);
    if (startMinutes == null) continue;
    for (let round = 0; round < maxReservationsPerPlayer; round += 1) {
      const beginMinutes = startMinutes + round * SQUASH_SLOT_MINUTES;
      const beginTime = formatTeamrTimeFromMinutes(beginMinutes);
      const endTime = formatTeamrTimeFromMinutes(beginMinutes + SQUASH_SLOT_MINUTES);
      for (let court = 1; court <= SQUASH_COURT_COUNT; court += 1) {
        seq += 1;
        slots.push({ sessionId: `sim-${seq}`, court, beginTime, endTime });
      }
    }
  }
  return slots;
}

function deriveVotes(
  candidateStartTimes: string[],
  players: ScenarioPlayerVote[],
): { confirmedPlayerIdsByTime: Record<string, string[]>; volunteerSubstituteIds: string[] } {
  const confirmedPlayerIdsByTime: Record<string, string[]> = {};
  for (const time of candidateStartTimes) confirmedPlayerIdsByTime[time] = [];
  const volunteerSubstituteIds: string[] = [];
  for (const { playerId, vote } of players) {
    if (vote === "prete-nom") {
      volunteerSubstituteIds.push(playerId);
    } else if (confirmedPlayerIdsByTime[vote]) {
      confirmedPlayerIdsByTime[vote]!.push(playerId);
    }
  }
  return { confirmedPlayerIdsByTime, volunteerSubstituteIds };
}

/**
 * Calcule le plan pour un scénario simulé : disponibilité synthétique "tout libre" (assez de
 * créneaux pour couvrir maxReservationsPerPlayer rounds par heure candidate, sur
 * SQUASH_COURT_COUNT courts), votes dérivés directement des joueurs du scénario (pas de sondage
 * réel). Appelle planJobBookings — le même code que le nœud de production bookSlots.ts.
 */
export function simulateScenario(
  rule: BookingRule,
  players: ScenarioPlayerVote[],
  apiUserId: string | null,
): BookingPlanGroup[] {
  const availableSlots = synthesizeAvailableSlots(rule.candidateStartTimes, rule.maxReservationsPerPlayer);
  const { confirmedPlayerIdsByTime, volunteerSubstituteIds } = deriveVotes(rule.candidateStartTimes, players);
  return planJobBookings(rule, SIMULATION_DATE, confirmedPlayerIdsByTime, volunteerSubstituteIds, availableSlots, apiUserId);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- simulateScenario.test.ts
```

Expected: `PASS`, 5 tests verts.

- [ ] **Step 5: Suite complète + typecheck**

```bash
npm test
npx tsc -p tsconfig.build.json
```

Expected: tout vert.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/planning/simulateScenario.ts apps/worker/src/planning/simulateScenario.test.ts
git commit -m "feat(worker): simulateScenario — calcul de plan avec disponibilité synthétique"
```

---

### Task 4: Persistance côté worker (`scenarios.ts`) + endpoint HTTP de simulation

**Files:**
- Create: `apps/worker/src/scenarios.ts`
- Modify: `apps/worker/src/http/server.ts`

**Interfaces:**
- Consumes: `Scenario`/`scenarios`/`ScenarioPlayer` (`@squash-assistant/db/schema`, Task 1), `simulateScenario` (Task 3), `getBookingRuleById` (`apps/worker/src/bookingRules.ts`, déjà existant).
- Produces: `getScenarioById(db, bookingRuleId, scenarioId): Promise<Scenario | undefined>`, `saveScenarioPlan(db, scenarioId, plan: unknown): Promise<Scenario>`.

- [ ] **Step 1: Créer `apps/worker/src/scenarios.ts`**

```ts
import { and, eq } from "drizzle-orm";
import type { Database } from "@squash-assistant/db/client";
import { scenarios, type Scenario } from "@squash-assistant/db/schema";

export async function getScenarioById(
  db: Database,
  bookingRuleId: string,
  scenarioId: string,
): Promise<Scenario | undefined> {
  const [scenario] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.bookingRuleId, bookingRuleId), eq(scenarios.id, scenarioId)));
  return scenario;
}

/** Persiste le résultat du calcul de plan — appelé par l'endpoint HTTP de simulation (server.ts). */
export async function saveScenarioPlan(db: Database, scenarioId: string, plan: unknown): Promise<Scenario> {
  const [scenario] = await db.update(scenarios).set({ lastPlan: plan }).where(eq(scenarios.id, scenarioId)).returning();
  return scenario;
}
```

- [ ] **Step 2: Ajouter la route dans `apps/worker/src/http/server.ts`**

Ajouter l'import en haut du fichier (avec les autres imports de modules locaux) :

```ts
import { getScenarioById, saveScenarioPlan } from "../scenarios.js";
import { simulateScenario } from "../planning/simulateScenario.js";
```

Ajouter la regex de route à côté des autres `const ..._ROUTE` :

```ts
const SCENARIO_SIMULATE_ROUTE = /^\/rules\/([^/]+)\/scenarios\/([^/]+)\/simulate$/;
```

Ajouter le dispatch dans `handleRequest`, juste avant le `sendJson(res, 404, ...)` final :

```ts
  const scenarioSimulateMatch = req.method === "POST" ? SCENARIO_SIMULATE_ROUTE.exec(url.pathname) : null;
  if (scenarioSimulateMatch) {
    await handleSimulateScenario(res, deps, scenarioSimulateMatch[1], scenarioSimulateMatch[2]);
    return;
  }
```

Ajouter le handler (à côté des autres fonctions `handle*`) :

```ts
async function handleSimulateScenario(
  res: ServerResponse,
  deps: HttpServerDeps,
  ruleId: string,
  scenarioId: string,
): Promise<void> {
  const rule = await getBookingRuleById(deps.db, ruleId);
  if (!rule) {
    sendJson(res, 404, { error: `Règle "${ruleId}" introuvable.` });
    return;
  }
  const scenario = await getScenarioById(deps.db, ruleId, scenarioId);
  if (!scenario) {
    sendJson(res, 404, { error: `Scénario "${scenarioId}" introuvable.` });
    return;
  }
  try {
    const bookingPlanGroups = simulateScenario(
      rule,
      scenario.players.map((p) => ({ playerId: p.playerId, vote: p.vote })),
      scenario.apiUserId,
    );
    const updated = await saveScenarioPlan(deps.db, scenarioId, bookingPlanGroups);
    sendJson(res, 200, { scenario: updated, bookingPlanGroups });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
```

- [ ] **Step 3: Typecheck + build**

```bash
cd apps/worker
npx tsc -p tsconfig.build.json
npm test
```

Expected: `TypeScript: No errors found`, tous les tests verts (aucun test n'exerce encore ce nouvel endpoint — couvert indirectement par Task 3, testé manuellement en Task 9 via l'UI).

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/scenarios.ts apps/worker/src/http/server.ts
git commit -m "feat(worker): endpoint POST /rules/:id/scenarios/:scenarioId/simulate"
```

---

### Task 5: CRUD scénarios côté UI (accès DB direct)

**Files:**
- Create: `apps/ui/src/lib/scenarios.ts`

**Interfaces:**
- Consumes: `getDb` (`apps/ui/src/lib/db.ts`), `scenarios`/`Scenario`/`ScenarioPlayer` (`@squash-assistant/db/schema`).
- Produces: `listScenarios(bookingRuleId): Promise<Scenario[]>`, `getScenario(bookingRuleId, scenarioId): Promise<Scenario | undefined>`, `createScenario(input): Promise<Scenario>`, `updateScenario(scenarioId, input): Promise<Scenario>`, `deleteScenario(scenarioId): Promise<void>`, `ruleHasScenarios(bookingRuleId): Promise<boolean>`.

- [ ] **Step 1: Créer `apps/ui/src/lib/scenarios.ts`**

```ts
import { and, eq } from "drizzle-orm";
import { scenarios, type Scenario, type ScenarioPlayer } from "@squash-assistant/db/schema";
import { getDb } from "./db";

export function listScenarios(bookingRuleId: string): Promise<Scenario[]> {
  return getDb().select().from(scenarios).where(eq(scenarios.bookingRuleId, bookingRuleId));
}

export async function getScenario(bookingRuleId: string, scenarioId: string): Promise<Scenario | undefined> {
  const [scenario] = await getDb()
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.bookingRuleId, bookingRuleId), eq(scenarios.id, scenarioId)));
  return scenario;
}

export interface CreateScenarioInput {
  bookingRuleId: string;
  name: string;
  players: ScenarioPlayer[];
  apiUserId: string | null;
}

export async function createScenario(input: CreateScenarioInput): Promise<Scenario> {
  const [scenario] = await getDb().insert(scenarios).values(input).returning();
  return scenario;
}

export interface UpdateScenarioInput {
  name?: string;
  players?: ScenarioPlayer[];
  apiUserId?: string | null;
  validated?: boolean | null;
}

export async function updateScenario(scenarioId: string, input: UpdateScenarioInput): Promise<Scenario> {
  const [scenario] = await getDb().update(scenarios).set(input).where(eq(scenarios.id, scenarioId)).returning();
  return scenario;
}

export async function deleteScenario(scenarioId: string): Promise<void> {
  await getDb().delete(scenarios).where(eq(scenarios.id, scenarioId));
}

/** Verrouillage : une règle référencée par au moins un scénario ne peut plus être éditée (voir actions.ts, rules/[id]/edit/page.tsx). */
export async function ruleHasScenarios(bookingRuleId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: scenarios.id })
    .from(scenarios)
    .where(eq(scenarios.bookingRuleId, bookingRuleId))
    .limit(1);
  return rows.length > 0;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/ui
npm run typecheck
```

Expected: pas d'erreur.

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/lib/scenarios.ts
git commit -m "feat(ui): CRUD scénarios en accès DB direct (comme booking_rules)"
```

---

### Task 6: Client HTTP `simulateScenario` côté UI

**Files:**
- Modify: `apps/ui/src/lib/worker.ts`

**Interfaces:**
- Consumes: `callWorker` (fonction privée déjà existante dans ce fichier).
- Produces: `simulateScenario(ruleId: string, scenarioId: string): Promise<{ scenario: unknown; bookingPlanGroups: unknown[] }>`.

- [ ] **Step 1: Ajouter la fonction dans `apps/ui/src/lib/worker.ts`**

Ajouter à la suite des autres fonctions exportées (ex. après `cancelPoll`) :

```ts
/** Calcule (et persiste) le plan d'un scénario de simulation — voir docs/adr/ADR-019. */
export function simulateScenario(ruleId: string, scenarioId: string): Promise<{ scenario: unknown; bookingPlanGroups: unknown[] }> {
  return callWorker(`/rules/${ruleId}/scenarios/${scenarioId}/simulate`, "POST") as Promise<{
    scenario: unknown;
    bookingPlanGroups: unknown[];
  }>;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/ui
npm run typecheck
```

Expected: pas d'erreur.

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/lib/worker.ts
git commit -m "feat(ui): client simulateScenario (appel worker)"
```

---

### Task 7: Server actions scénarios + garde de verrouillage sur `upsertRuleAction`

**Files:**
- Modify: `apps/ui/src/app/actions.ts`

**Interfaces:**
- Consumes: `listScenarios`/`getScenario`/`createScenario`/`updateScenario`/`deleteScenario`/`ruleHasScenarios` (Task 5), `simulateScenario` (Task 6, client HTTP).
- Produces (Server Actions, signature `(formData: FormData) => Promise<void>`, sauf mention contraire) : `createScenarioAction`, `saveScenarioAction`, `deleteScenarioAction`, `validateScenarioAction`, `computeScenarioPlanAction`.

- [ ] **Step 1: Ajouter les imports en haut de `apps/ui/src/app/actions.ts`**

```ts
import {
  createScenario,
  deleteScenario,
  ruleHasScenarios,
  updateScenario,
  type CreateScenarioInput,
} from "../lib/scenarios";
import { simulateScenario } from "../lib/worker";
```

(`simulateScenario` s'ajoute au bloc d'import existant depuis `../lib/worker` — fusionner avec les noms déjà importés de ce module plutôt que dupliquer la ligne `import ... from "../lib/worker"`.)

- [ ] **Step 2: Ajouter la garde de verrouillage dans `upsertRuleAction`**

Dans `upsertRuleAction`, juste après la ligne `const id = String(formData.get("id")).trim();` et avant la construction de `values`, insérer :

```ts
  if (!isNew && (await ruleHasScenarios(id))) {
    throw new Error(
      `Cette règle est utilisée par au moins un scénario de simulation — supprime-le(s) d'abord pour modifier la règle (voir /rules/${id}/simulator).`,
    );
  }
```

- [ ] **Step 3: Ajouter les actions scénarios à la fin du fichier**

```ts
function parseScenarioPlayers(formData: FormData): ScenarioPlayer[] {
  const raw = String(formData.get("playersJson") ?? "[]");
  return JSON.parse(raw) as ScenarioPlayer[];
}

export async function createScenarioAction(formData: FormData): Promise<void> {
  const bookingRuleId = String(formData.get("bookingRuleId"));
  const name = String(formData.get("name") ?? "Nouveau scénario").trim();
  const input: CreateScenarioInput = { bookingRuleId, name, players: [], apiUserId: null };
  const scenario = await createScenario(input);
  revalidatePath(`/rules/${bookingRuleId}/simulator`);
  redirect(`/rules/${bookingRuleId}/simulator/${scenario.id}`);
}

export async function saveScenarioAction(formData: FormData): Promise<void> {
  const bookingRuleId = String(formData.get("bookingRuleId"));
  const scenarioId = String(formData.get("scenarioId"));
  const name = String(formData.get("name") ?? "").trim();
  const apiUserId = String(formData.get("apiUserId") ?? "").trim() || null;
  const players = parseScenarioPlayers(formData);
  await updateScenario(scenarioId, { name, apiUserId, players, validated: null });
  revalidatePath(`/rules/${bookingRuleId}/simulator/${scenarioId}`);
}

export async function computeScenarioPlanAction(formData: FormData): Promise<void> {
  const bookingRuleId = String(formData.get("bookingRuleId"));
  const scenarioId = String(formData.get("scenarioId"));
  await simulateScenario(bookingRuleId, scenarioId);
  revalidatePath(`/rules/${bookingRuleId}/simulator/${scenarioId}`);
}

export async function validateScenarioAction(formData: FormData): Promise<void> {
  const bookingRuleId = String(formData.get("bookingRuleId"));
  const scenarioId = String(formData.get("scenarioId"));
  const validated = formData.get("validated") === "true";
  await updateScenario(scenarioId, { validated });
  revalidatePath(`/rules/${bookingRuleId}/simulator/${scenarioId}`);
}

export async function deleteScenarioAction(formData: FormData): Promise<void> {
  const bookingRuleId = String(formData.get("bookingRuleId"));
  const scenarioId = String(formData.get("scenarioId"));
  await deleteScenario(scenarioId);
  revalidatePath(`/rules/${bookingRuleId}/simulator`);
  redirect(`/rules/${bookingRuleId}/simulator`);
}
```

Ajouter l'import du type `ScenarioPlayer` en haut du fichier, dans le bloc d'import depuis `@squash-assistant/db/schema` déjà présent (fusionner, ne pas dupliquer la ligne) :

```ts
import { bookingRuleHistory, bookingRules, type ScenarioPlayer } from "@squash-assistant/db/schema";
```

- [ ] **Step 4: Typecheck**

```bash
cd apps/ui
npm run typecheck
```

Expected: pas d'erreur.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/app/actions.ts
git commit -m "feat(ui): server actions scénarios + verrouillage de règle référencée"
```

---

### Task 8: Page liste des scénarios

**Files:**
- Create: `apps/ui/src/app/rules/[id]/simulator/page.tsx`

**Interfaces:**
- Consumes: `listScenarios` (Task 5), `createScenarioAction`/`deleteScenarioAction` (Task 7), `getDb`/`bookingRules` (pattern existant, voir `rules/[id]/edit/page.tsx`).

- [ ] **Step 1: Créer la page**

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../../../../lib/db";
import { listScenarios } from "../../../../lib/scenarios";
import { createScenarioAction, deleteScenarioAction } from "../../../actions";
import { SubmitButton } from "../../../components/SubmitButton";

function statusBadge(validated: boolean | null): string {
  if (validated === true) return "OK";
  if (validated === false) return "Pas OK";
  return "Non évalué";
}

function statusClass(validated: boolean | null): string {
  if (validated === true) return "badge badge-on";
  if (validated === false) return "badge badge-off";
  return "badge";
}

export default async function ScenariosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [rule] = await getDb().select().from(bookingRules).where(eq(bookingRules.id, id));
  if (!rule) {
    notFound();
  }

  const scenarios = await listScenarios(id);

  return (
    <main>
      <p>
        <Link href={`/rules/${id}/edit`}>← Retour à la règle</Link>
      </p>
      <h1>Scénarios de simulation — {rule.name ?? rule.id}</h1>

      <table className="card">
        <thead>
          <tr>
            <th>Nom</th>
            <th>Statut</th>
            <th>Dernière modification</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {scenarios.map((s) => (
            <tr key={s.id}>
              <td>
                <Link href={`/rules/${id}/simulator/${s.id}`}>{s.name}</Link>
              </td>
              <td>
                <span className={statusClass(s.validated)}>{statusBadge(s.validated)}</span>
              </td>
              <td className="muted">{new Date(s.updatedAt).toLocaleString("fr-FR")}</td>
              <td>
                <form action={deleteScenarioAction}>
                  <input type="hidden" name="bookingRuleId" value={id} />
                  <input type="hidden" name="scenarioId" value={s.id} />
                  <SubmitButton className="button">Supprimer</SubmitButton>
                </form>
              </td>
            </tr>
          ))}
          {scenarios.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                Aucun scénario pour cette règle.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <form action={createScenarioAction} className="form-actions">
        <input type="hidden" name="bookingRuleId" value={id} />
        <input type="text" name="name" placeholder="Nom du nouveau scénario" required />
        <SubmitButton className="button-primary">Créer un scénario</SubmitButton>
      </form>
    </main>
  );
}
```

- [ ] **Step 2: Vérifier le build**

```bash
cd apps/ui
npm run build
```

Expected: build réussi, route `/rules/[id]/simulator` listée dans la sortie.

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/app/rules/\[id\]/simulator/page.tsx
git commit -m "feat(ui): page liste des scénarios de simulation"
```

---

### Task 9: Page + éditeur d'un scénario

**Files:**
- Create: `apps/ui/src/app/rules/[id]/simulator/[scenarioId]/page.tsx`
- Create: `apps/ui/src/app/rules/[id]/simulator/[scenarioId]/ScenarioEditor.tsx`

**Interfaces:**
- Consumes: `getScenario` (Task 5), `getGroupMemberNames` (`apps/ui/src/lib/worker.ts`, déjà existant), `saveScenarioAction`/`computeScenarioPlanAction`/`validateScenarioAction` (Task 7), `Scenario`/`ScenarioPlayer` (`@squash-assistant/db/schema`).

- [ ] **Step 1: Créer la page serveur**

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../../../../../lib/db";
import { getGroupMemberNames } from "../../../../../lib/worker";
import { getScenario } from "../../../../../lib/scenarios";
import { ScenarioEditor } from "./ScenarioEditor";

export default async function ScenarioPage({
  params,
}: {
  params: Promise<{ id: string; scenarioId: string }>;
}) {
  const { id, scenarioId } = await params;
  const [rule] = await getDb().select().from(bookingRules).where(eq(bookingRules.id, id));
  if (!rule) {
    notFound();
  }
  const scenario = await getScenario(id, scenarioId);
  if (!scenario) {
    notFound();
  }
  const playerNames = await getGroupMemberNames(id).catch(() => ({}) as Record<string, string>);

  return (
    <main>
      <p>
        <Link href={`/rules/${id}/simulator`}>← Tous les scénarios</Link>
      </p>
      <h1>{scenario.name}</h1>
      <p className="muted">
        Règle : {rule.name ?? rule.id} (lecture seule) — heures candidates : {rule.candidateStartTimes.join(", ")}
      </p>
      <ScenarioEditor ruleId={id} scenario={scenario} candidateStartTimes={rule.candidateStartTimes} playerNames={playerNames} />
    </main>
  );
}
```

- [ ] **Step 2: Créer le composant client `ScenarioEditor.tsx`**

```tsx
"use client";

import { useState } from "react";
import type { Scenario, ScenarioPlayer } from "@squash-assistant/db/schema";
import {
  computeScenarioPlanAction,
  saveScenarioAction,
  validateScenarioAction,
} from "../../../../actions";
import { SubmitButton } from "../../../../components/SubmitButton";

interface Props {
  ruleId: string;
  scenario: Scenario;
  candidateStartTimes: string[];
  playerNames: Record<string, string>;
}

const NO_VOTE = "non";
const SUBSTITUTE_VOTE = "prete-nom";

export function ScenarioEditor({ ruleId, scenario, candidateStartTimes, playerNames }: Props) {
  const [players, setPlayers] = useState<ScenarioPlayer[]>(scenario.players);
  const [apiUserId, setApiUserId] = useState<string>(scenario.apiUserId ?? "");
  const availablePlayerIds = Object.keys(playerNames).filter((id) => !players.some((p) => p.playerId === id));

  function addPlayer(playerId: string): void {
    if (!playerId) return;
    setPlayers((prev) => [...prev, { playerId, name: playerNames[playerId] ?? playerId, vote: NO_VOTE }]);
  }

  function setVote(playerId: string, vote: string): void {
    setPlayers((prev) => prev.map((p) => (p.playerId === playerId ? { ...p, vote } : p)));
  }

  function removePlayer(playerId: string): void {
    setPlayers((prev) => prev.filter((p) => p.playerId !== playerId));
    if (apiUserId === playerId) setApiUserId("");
  }

  const plan = scenario.lastPlan as
    | Array<{ startTime: string; plan: { proposedBookings: Array<{ court: number; slotTime: string; slotEndTime: string; userId: string; partnerId?: string }>; warnings: string[] } }>
    | null;

  return (
    <div>
      <form action={saveScenarioAction}>
        <input type="hidden" name="bookingRuleId" value={ruleId} />
        <input type="hidden" name="scenarioId" value={scenario.id} />
        <input type="hidden" name="playersJson" value={JSON.stringify(players)} />

        <div className="form-grid">
          <label>
            Nom
            <input type="text" name="name" defaultValue={scenario.name} required />
          </label>
        </div>

        <h2>Joueurs</h2>
        <table className="card">
          <thead>
            <tr>
              <th>Joueur</th>
              <th>Vote</th>
              <th>Titulaire (exempté)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.playerId}>
                <td>{p.name}</td>
                <td>
                  <select value={p.vote} onChange={(e) => setVote(p.playerId, e.target.value)}>
                    {candidateStartTimes.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                    <option value={SUBSTITUTE_VOTE}>Prête mon nom</option>
                    <option value={NO_VOTE}>Non</option>
                  </select>
                </td>
                <td>
                  <input
                    type="radio"
                    name="apiUserIdRadio"
                    checked={apiUserId === p.playerId}
                    onChange={() => setApiUserId(p.playerId)}
                  />
                </td>
                <td>
                  <button type="button" className="button" onClick={() => removePlayer(p.playerId)}>
                    Retirer
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <input type="hidden" name="apiUserId" value={apiUserId} />

        <div className="form-actions">
          <select onChange={(e) => addPlayer(e.target.value)} value="">
            <option value="">+ Ajouter un joueur…</option>
            {availablePlayerIds.map((id) => (
              <option key={id} value={id}>
                {playerNames[id]}
              </option>
            ))}
          </select>
          <SubmitButton className="button-primary">Sauvegarder</SubmitButton>
        </div>
      </form>

      <form action={computeScenarioPlanAction} style={{ marginTop: "1rem" }}>
        <input type="hidden" name="bookingRuleId" value={ruleId} />
        <input type="hidden" name="scenarioId" value={scenario.id} />
        <SubmitButton className="button-primary">Calculer le plan</SubmitButton>
      </form>

      {plan && (
        <div className="pipeline-step" style={{ marginTop: "1rem" }}>
          <h2>Plan calculé</h2>
          {plan.map((g) => (
            <div key={g.startTime}>
              <h3>{g.startTime}</h3>
              {g.plan.proposedBookings.length === 0 ? (
                <p className="muted">Aucun créneau ({g.plan.warnings.join(" ")})</p>
              ) : (
                <ul>
                  {g.plan.proposedBookings.map((b, i) => (
                    <li key={i}>
                      Court {b.court} — {b.slotTime}-{b.slotEndTime} — {playerNames[b.userId] ?? b.userId}
                      {b.partnerId ? ` et ${playerNames[b.partnerId] ?? b.partnerId}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              {g.plan.warnings.length > 0 && (
                <ul className="muted">
                  {g.plan.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}

          <div className="form-actions">
            <form action={validateScenarioAction}>
              <input type="hidden" name="bookingRuleId" value={ruleId} />
              <input type="hidden" name="scenarioId" value={scenario.id} />
              <input type="hidden" name="validated" value="true" />
              <SubmitButton className="button-primary">Valider (OK)</SubmitButton>
            </form>
            <form action={validateScenarioAction}>
              <input type="hidden" name="bookingRuleId" value={ruleId} />
              <input type="hidden" name="scenarioId" value={scenario.id} />
              <input type="hidden" name="validated" value="false" />
              <SubmitButton className="button">Invalider (pas OK)</SubmitButton>
            </form>
            {scenario.validated === true && (
              <a
                className="button"
                href={`data:application/json,${encodeURIComponent(
                  JSON.stringify({ scenario: { name: scenario.name, players, apiUserId: apiUserId || null }, expectedPlan: plan }, null, 2),
                )}`}
                download={`${scenario.name.replace(/\W+/g, "-").toLowerCase()}.json`}
              >
                Exporter
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Vérifier le build**

```bash
cd apps/ui
npm run build
```

Expected: build réussi, route `/rules/[id]/simulator/[scenarioId]` listée.

- [ ] **Step 4: Test manuel bout-en-bout**

```bash
cd apps/ui && npm run dev
```

Ouvrir `/rules/<une-règle-existante>/simulator`, créer un scénario, ajouter 2 joueurs, voter la même heure candidate pour les deux, "Calculer le plan" → vérifier qu'une réservation apparaît avec un court libre. Cliquer "Valider (OK)" → vérifier que le bouton "Exporter" apparaît et déclenche un téléchargement JSON.

- [ ] **Step 5: Commit**

```bash
git add "apps/ui/src/app/rules/[id]/simulator/[scenarioId]/"
git commit -m "feat(ui): éditeur de scénario (joueurs, votes, calcul de plan, validation, export)"
```

---

### Task 10: Verrouillage visuel de la page d'édition de règle

**Files:**
- Modify: `apps/ui/src/app/rules/[id]/edit/page.tsx`

**Interfaces:**
- Consumes: `ruleHasScenarios` (Task 5).

- [ ] **Step 1: Ajouter la vérification et le message de verrouillage**

Dans `apps/ui/src/app/rules/[id]/edit/page.tsx`, ajouter l'import :

```ts
import { ruleHasScenarios } from "../../../../lib/scenarios";
```

Juste après le chargement de `rule` (après le `if (!rule) { notFound(); }`), ajouter :

```ts
  const locked = await ruleHasScenarios(id);
```

Dans le JSX retourné, avant le rendu de `<RuleForm ... />`, insérer une branche conditionnelle :

```tsx
      {locked ? (
        <div className="pipeline-step-error" style={{ padding: "1rem", borderRadius: "8px" }}>
          <p>
            Cette règle est utilisée par au moins un scénario de simulation — supprime-le(s) d'abord pour la
            modifier.
          </p>
          <p>
            <Link href={`/rules/${id}/simulator`}>Voir les scénarios de cette règle</Link>
          </p>
        </div>
      ) : (
        <RuleForm
          {/* props existantes inchangées */}
        />
      )}
```

(Garder toutes les props déjà passées à `<RuleForm>` telles quelles — seul le wrapping conditionnel change.)

- [ ] **Step 2: Vérifier le build**

```bash
cd apps/ui
npm run build
```

Expected: build réussi.

- [ ] **Step 3: Test manuel**

Créer un scénario pour une règle de test, recharger sa page `/rules/[id]/edit` → vérifier que le formulaire est remplacé par le message de verrouillage. Supprimer le scénario → vérifier que le formulaire réapparaît.

- [ ] **Step 4: Commit**

```bash
git add "apps/ui/src/app/rules/[id]/edit/page.tsx"
git commit -m "feat(ui): verrouillage visuel de l'édition de règle référencée par un scénario"
```

---

### Task 11: Suite de non-régression basée sur les fixtures exportées

**Files:**
- Create: `apps/worker/src/planning/__fixtures__/scenarios/.gitkeep`
- Create: `apps/worker/src/planning/scenarios.regression.test.ts`

**Interfaces:**
- Consumes: `simulateScenario` (Task 3), `BookingRule` (`config.ts`).

- [ ] **Step 1: Créer le dossier de fixtures (vide au départ)**

```bash
mkdir -p apps/worker/src/planning/__fixtures__/scenarios
touch apps/worker/src/planning/__fixtures__/scenarios/.gitkeep
```

- [ ] **Step 2: Écrire le test paramétré**

Créer `apps/worker/src/planning/scenarios.regression.test.ts` :

```ts
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { simulateScenario, type ScenarioPlayerVote } from "./simulateScenario.js";
import type { BookingRule } from "../config.js";

interface ScenarioFixture {
  scenario: { name: string; players: ScenarioPlayerVote[]; apiUserId: string | null };
  rule: Pick<
    BookingRule,
    | "candidateStartTimes"
    | "maxReservationsPerPlayer"
    | "maxCourtsPerSlot"
    | "minPlayersPerCourt"
    | "maxPlayersPerCourt"
    | "preferMinPlayersPerCourt"
    | "courtPriority"
    | "maxDailyReservationsPerPlayer"
    | "substituteBookers"
    | "availabilityWindowHours"
    | "priorityBookers"
  >;
  expectedPlan: unknown;
}

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "scenarios");

function fullRule(partial: ScenarioFixture["rule"]): BookingRule {
  return {
    id: "fixture-rule",
    name: null,
    enabled: false,
    whatsappGroupJid: "fixture@test",
    resaSquashGroupId: "fixture-group",
    pollCron: "0 10 * * 2",
    decisionCron: "30 21 * * 2",
    targetWeekdayOffset: 7,
    description: null,
    ...partial,
  };
}

describe("scenarios de non-régression (exportés depuis le simulateur)", () => {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));

  if (files.length === 0) {
    it.skip("aucune fixture exportée pour le moment", () => {});
    return;
  }

  for (const file of files) {
    it(`${file} produit toujours le plan attendu`, () => {
      const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf-8")) as ScenarioFixture;
      const groups = simulateScenario(fullRule(fixture.rule), fixture.scenario.players, fixture.scenario.apiUserId);
      expect(groups).toEqual(fixture.expectedPlan);
    });
  }
});
```

- [ ] **Step 2: Run to verify it passes (aucune fixture au départ)**

```bash
cd apps/worker
npm test -- scenarios.regression.test.ts
```

Expected: `PASS` (1 test `skip`, aucune fixture à ce stade).

- [ ] **Step 3: Suite complète**

```bash
npm test
```

Expected: tous les tests verts.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/planning/__fixtures__ apps/worker/src/planning/scenarios.regression.test.ts
git commit -m "test(worker): suite de non-régression basée sur les fixtures de scénarios exportés"
```

---

### Task 12: Documentation

**Files:**
- Modify: `docs/spec/regles-fonctionnelles.md`
- Create: `docs/adr/ADR-019-simulateur-scenarios-reservation.md`

- [ ] **Step 1: Ajouter une section au fichier `docs/spec/regles-fonctionnelles.md`**

Ajouter avant la section "## 5. Étape 4" (ou en nouvelle section numérotée après l'étape 4 existante, à ajuster selon la numérotation en place au moment de l'implémentation) :

```markdown
## Simulateur de scénarios de réservation

- Accessible depuis la page d'une règle (`/rules/[id]/simulator`) : liste des scénarios, création/suppression.
- Un scénario associe à UNE règle donnée un jeu de joueurs, chacun avec un vote (une heure candidate de la règle, "Prête mon nom", ou "Non" — mutuellement exclusif, miroir du vrai sondage WhatsApp).
- "Calculer le plan" exerce le vrai moteur (`computeGroupBookingPlan` via `planJobBookings`/`simulateScenario`) avec une disponibilité de courts synthétique où tout est libre — aucun appel MCP réel.
- Le plafond de résas/jour part toujours de zéro dans un scénario ; seul un dépassement au sein même du scénario peut déclencher une substitution.
- "Valider (OK)" / "Invalider (pas OK)" enregistre un jugement manuel sur le plan calculé.
- **Une règle référencée par au moins un scénario ne peut plus être modifiée** — supprimer le(s) scénario(s) d'abord (verrouillage appliqué côté UI et côté serveur).
- "Exporter" (visible seulement si validé OK) télécharge un JSON à déposer manuellement dans `apps/worker/src/planning/__fixtures__/scenarios/` — rejoué automatiquement par `scenarios.regression.test.ts` à chaque `npm test`.
```

Ajouter une ligne au tableau de changelog en fin de fichier :

```markdown
| 2026-08-01 | Simulateur de scénarios de réservation (`/rules/[id]/simulator`) + verrouillage des règles référencées + export vers non-régression | Aucun outil ne permettait de vérifier visuellement le comportement du moteur avant déploiement d'un changement de règle métier — voir ADR-019 |
```

- [ ] **Step 2: Créer `docs/adr/ADR-019-simulateur-scenarios-reservation.md`**

```markdown
# ADR-019 – Simulateur de scénarios de réservation

**Status:** accepted
**Date:** 2026-08-01

## Contexte

Chaque ajustement de règle métier du moteur d'allocation (`apps/worker/src/planning/`, ADR-018) n'était vérifiable qu'en écrivant des tests unitaires à la main ou en observant le comportement réel en production — deux corrections coup sur coup le 2026-08-01 (continuité de court avec prête-nom changeant, plafond de résas/jour appliqué au mauvais joueur) ont montré le besoin d'un outil de vérification visuelle avant déploiement.

## Décision

### 1. Scénarios comme entité de première classe, liée à une règle précise

Nouvelle table `scenarios` (FK vers `booking_rules`, `ON DELETE CASCADE`) : un jeu de joueurs avec leur vote, un statut de validation manuel (OK / pas OK / non évalué), un cache du dernier plan calculé.

### 2. Réutilisation stricte du moteur de production

`bookSlots.ts` (nœud réel) et le simulateur appellent tous les deux `planJobBookings` (nouveau module partagé, `planning/planJob.ts`, extrait de la boucle candidate-heure de `bookSlots.ts`) — seule la source de la disponibilité des courts diffère (réelle via `list_availability`, synthétique "tout libre" pour le simulateur). Aucune logique dupliquée : toute divergence de comportement invaliderait l'utilité du simulateur comme outil de décision.

### 3. CRUD scénarios en accès DB direct depuis l'UI, calcul de plan via le worker

Contrairement aux jobs (`job_runs`), qui passent par l'API HTTP interne du worker parce qu'ils dépendent de l'état LangGraph, les scénarios sont de simples lignes DB sans composante d'orchestration — leur CRUD suit donc le pattern déjà utilisé pour `booking_rules` (accès Drizzle direct depuis les Server Actions `apps/ui`). Seul le calcul du plan (`computeGroupBookingPlan`/`planJobBookings`, code qui vit dans `apps/worker`) passe par un nouvel endpoint HTTP `POST /rules/:id/scenarios/:scenarioId/simulate`.

### 4. Verrouillage d'une règle référencée par un scénario

Une règle avec au moins un scénario ne peut plus être modifiée (les scénarios ne portent que sur les votes des joueurs — la règle elle-même doit rester stable pour que le scénario garde son sens). Défense en profondeur : garde côté UI (formulaire remplacé par un message) et côté serveur (`upsertRuleAction` lève une erreur explicite).

### 5. Export manuel vers une suite de non-régression versionnée

Aucune écriture directe dans le repo git depuis un pod (UI et worker n'ont pas de checkout du repo en prod) : "Exporter" télécharge un JSON, à déposer manuellement dans `apps/worker/src/planning/__fixtures__/scenarios/` et committer. `scenarios.regression.test.ts` parcourt ce dossier à chaque exécution de `npm test` et vérifie que chaque fixture produit toujours le plan attendu.

## Raisons

- Un outil de vérification visuelle avant déploiement réduit le risque de régression fonctionnelle silencieuse sur la logique de réservation — deux bugs de comportement corrigés le même jour (2026-08-01) auraient été détectés plus tôt avec cet outil en place.
- Réutiliser `planJobBookings` plutôt que dupliquer la boucle de planification est la seule façon pour le simulateur de rester une source de vérité fiable dans la durée.
- Suivre le pattern d'accès DB déjà en place pour `booking_rules` (plutôt qu'un détour systématique par le worker) évite une couche HTTP inutile pour de simples opérations CRUD.

## Conséquences

- `apps/worker/src/planning/planJob.ts`, `simulateScenario.ts`, `scenarios.ts` : nouveaux modules.
- `apps/worker/src/graph/nodes/bookSlots.ts` : refactoré pour appeler `planJobBookings` (comportement inchangé, couvert par `bookSlots.test.ts`).
- `apps/ui/src/lib/scenarios.ts`, `apps/ui/src/app/rules/[id]/simulator/**` : nouvelle section UI.
- `packages/db/src/schema.ts` : nouvelle table `scenarios`.
- Aucun changement de contrat MCP (huddle-bot, resa-squash) — le simulateur n'appelle aucun des deux au moment du calcul de plan.
```

- [ ] **Step 3: Commit**

```bash
git add docs/spec/regles-fonctionnelles.md docs/adr/ADR-019-simulateur-scenarios-reservation.md
git commit -m "docs: documente le simulateur de scénarios (règles fonctionnelles + ADR-019)"
```

---

## Vérification finale

Après la Task 12 :

```bash
cd apps/worker && npm test && npx tsc -p tsconfig.build.json
cd ../../apps/ui && npm run typecheck && npm run build
```

Expected : tout vert, aucune erreur. Tester manuellement le parcours complet une dernière fois (créer un scénario, calculer un plan, valider, exporter, tenter de modifier la règle verrouillée, supprimer le scénario, vérifier que la règle redevient modifiable).
