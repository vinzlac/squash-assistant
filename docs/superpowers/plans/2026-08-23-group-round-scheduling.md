# Planification par groupes et rounds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer, dans le moteur local de planification (`apps/worker/src/planning/`), le calcul par "couches" rigides + intégration après coup du joueur en rotation par un modèle de "groupes" (2 ou 3 joueurs) dont le nombre de rounds nécessaires est calculé globalement (pas de suivi de présence round par round) et sensible aux préférences individuelles de temps de jeu.

**Architecture:** Nouveau module `groups.ts` (construction des groupes + formule de rounds + nommage round-robin), nouveau module `scheduleGroupTimeline.ts` (remplissage d'un groupe sur une timeline continue). `groupBookingPlan.ts` devient un dispatcher : cas courant (`pairs.length <= courtsNeeded`, aucune file d'attente) → nouveau chemin par groupes ; cas file d'attente (plus de paires que de courts simultanés) → logique existante extraite telle quelle, hors périmètre de cette refonte. `sessionExtension.ts` (fusion de votants tardifs à une heure candidate ultérieure, cas différent conservé) adopte le même principe de rounds globaux.

**Tech Stack:** TypeScript, Vitest (AAA, noms de test descriptifs en français — conventions déjà en place dans `apps/worker/src/planning/*.test.ts`).

**Spec:** `docs/superpowers/specs/2026-08-23-group-round-scheduling-design.md`

## Global Constraints

- Aucun changement du contrat MCP resa-squash, ni du type `GroupBookingPlan` exposé en aval (`apps/worker/src/mcp/resaSquash.ts` — `proposedBookings`/`warnings`/`meta` inchangés).
- Le cas "plus de groupes que de courts simultanés" (`pairs.length > courtsNeeded`) garde le comportement actuel à l'identique — hors périmètre (spec §2).
- `buildPairsForGroupBooking` (`pairing.ts`) ne change pas — jamais plus d'un `rotatingPlayerId`.
- Toute commande shell depuis la racine du repo (`/Users/vinz/workspace/squash-assistant`), typecheck via `./node_modules/.bin/tsc -p apps/worker/tsconfig.build.json --noEmit`, tests via `cd apps/worker && npx vitest run <fichier>` (ou `/Users/vinz/workspace/squash-assistant/node_modules/.bin/vitest run <fichier> --root /Users/vinz/workspace/squash-assistant/apps/worker` si `npx` est intercepté par un wrapper local).
- Style de test : `describe`/`it`/`expect` Vitest, AAA, noms de test descriptifs en français — suivre `apps/worker/src/planning/groupBookingPlan.test.ts` et `apps/worker/src/planning/pairing.test.ts`.

---

## File Structure

| Fichier | Rôle |
|---|---|
| `apps/worker/src/planning/groups.ts` | **Nouveau** — `Group`, `orderMembersByDemand`, `computeRoundsNeededForMembers`, `teamrNamesForRound`, `buildGroupsForBooking` |
| `apps/worker/src/planning/groups.test.ts` | **Nouveau** |
| `apps/worker/src/planning/scheduleGroupTimeline.ts` | **Nouveau** — remplit un groupe sur une timeline continue |
| `apps/worker/src/planning/scheduleGroupTimeline.test.ts` | **Nouveau** |
| `apps/worker/src/planning/courtAssignment.ts` | Modifié — exporte `orderByCourtPriority` |
| `apps/worker/src/planning/sessionExtension.ts` | Modifié — `OngoingSession` simplifié (`members` au lieu de `players`/`pairUserId`/`pairPartnerId`/`playerJoinTimes`), `extendSessionForLateJoiners` basé sur rounds globaux |
| `apps/worker/src/planning/sessionExtension.test.ts` | **Nouveau** (n'existait pas — testé aujourd'hui uniquement via les appelants) |
| `apps/worker/src/planning/planJob.ts` | Modifié — adapte les appels à `buildOngoingSessionsFromPlan`/`extendSessionForLateJoiners`/`appendBookingsToGroupPlan` au nouveau modèle |
| `apps/worker/src/planning/planJob.test.ts` | Vérifié/ajusté si des textes de warning changent |
| `apps/worker/src/planning/groupBookingPlan.ts` | Modifié — dispatcher `computeCommonCasePlan`/`computeQueueingCasePlan` |
| `apps/worker/src/planning/groupBookingPlan.test.ts` | Nouveaux scénarios + régression |
| `apps/worker/src/planning/scenarios.regression.test.ts` + fixtures | Rejoué, textes de warning ajustés si besoin |
| `docs/spec/regles-fonctionnelles.md` | §4 mis à jour |

---

### Task 1: `groups.ts` — `teamrNamesForRound` et `orderMembersByDemand`

**Files:**
- Create: `apps/worker/src/planning/groups.ts`
- Test: `apps/worker/src/planning/groups.test.ts`

**Interfaces:**
- Consumes: `resolvePlayerPlaySlots`, `PlayerPlaySlotsMap`, `PlaySlotsDefaults` de `./playerPlaySlots.js`
- Produces: `Group { members: string[]; roundsNeeded: number }`, `teamrNamesForRound(groupSize: 2 | 3, roundIndex: number): [number, number]`, `orderMembersByDemand(members: string[], playSlotsDefaults: PlaySlotsDefaults, playerPlaySlots: PlayerPlaySlotsMap): string[]`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/planning/groups.test.ts
import { describe, expect, it } from "vitest";
import { orderMembersByDemand, teamrNamesForRound } from "./groups.js";
import type { PlayerPlaySlots, PlaySlotsDefaults } from "./playerPlaySlots.js";

const defaults: PlaySlotsDefaults = { defaultMinPlaySlots: 2, defaultMaxPlaySlots: 2 };

describe("teamrNamesForRound", () => {
  it("groupe de 2 : toujours les mêmes indices, quel que soit le round", () => {
    expect(teamrNamesForRound(2, 0)).toEqual([0, 1]);
    expect(teamrNamesForRound(2, 5)).toEqual([0, 1]);
  });

  it("groupe de 3 : cycle round-robin sur 3 rounds, chaque duo apparaît une fois par cycle puis se répète", () => {
    expect(teamrNamesForRound(3, 0)).toEqual([0, 1]);
    expect(teamrNamesForRound(3, 1)).toEqual([0, 2]);
    expect(teamrNamesForRound(3, 2)).toEqual([1, 2]);
    expect(teamrNamesForRound(3, 3)).toEqual([0, 1]);
    expect(teamrNamesForRound(3, 4)).toEqual([0, 2]);
  });
});

describe("orderMembersByDemand", () => {
  it("groupe de 2 : ordre inchangé", () => {
    expect(orderMembersByDemand(["a", "b"], defaults, new Map())).toEqual(["a", "b"]);
  });

  it("groupe de 3 : trie par minSlots décroissant, le plus exigeant en position 0", () => {
    const overrides = new Map<string, PlayerPlaySlots>([["c", { minSlots: 3, maxSlots: 3 }]]);
    expect(orderMembersByDemand(["a", "b", "c"], defaults, overrides)).toEqual(["c", "a", "b"]);
  });

  it("groupe de 3 sans préférence particulière : ordre stable (tri égal ne réordonne pas)", () => {
    expect(orderMembersByDemand(["a", "b", "c"], defaults, new Map())).toEqual(["a", "b", "c"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && npx vitest run src/planning/groups.test.ts`
Expected: FAIL — le module `./groups.js` n'existe pas.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/worker/src/planning/groups.ts
import { resolvePlayerPlaySlots, type PlayerPlaySlotsMap, type PlaySlotsDefaults } from "./playerPlaySlots.js";

export interface Group {
  /**
   * 2 joueurs (paire classique) ou 3 (paire + joueur en rotation fusionné).
   * Pour un groupe de 3, ordonné par `minSlots` décroissant (position 0 = le
   * plus exigeant) — l'ordre conditionne `computeRoundsNeededForMembers` et
   * le nommage TeamR par round (`teamrNamesForRound`), qui indexent tous les
   * deux `members`.
   */
  members: string[];
  /** Nombre de rounds de 45 min à réserver sur le court de ce groupe. */
  roundsNeeded: number;
}

/**
 * Index dans `members` des 2 joueurs nommés sur la ligne TeamR pour un round donné du groupe.
 * Le moteur ne calcule pas qui est physiquement présent à quel round — les joueurs s'arrangent
 * entre eux une fois le court réservé (simplification actée 2026-08-23) ; ce cycle fixe garantit
 * seulement que chaque duo apparaît une fois par cycle complet de 3 rounds.
 */
export function teamrNamesForRound(groupSize: 2 | 3, roundIndex: number): [number, number] {
  if (groupSize === 2) return [0, 1];
  const cycle: Array<[number, number]> = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  return cycle[roundIndex % 3]!;
}

/**
 * Pour un groupe de 3, trie par `minSlots` décroissant — position 0 = le plus exigeant. Le cycle
 * round-robin fixe de `teamrNamesForRound` ne donne pas le même rythme d'apparition aux 3
 * positions sur un cycle incomplet (positions 0 et 1 rattrapent leur quota plus vite que la
 * position 2) : mettre le membre le plus exigeant en position 0 minimise le nombre de rounds
 * nécessaires. Pour 2 joueurs ou moins, ordre inchangé (les 2 jouent toujours ensemble).
 */
export function orderMembersByDemand(
  members: string[],
  playSlotsDefaults: PlaySlotsDefaults,
  playerPlaySlots: PlayerPlaySlotsMap,
): string[] {
  if (members.length <= 2) return members;
  return [...members].sort(
    (a, b) =>
      resolvePlayerPlaySlots(b, playSlotsDefaults, playerPlaySlots).minSlots -
      resolvePlayerPlaySlots(a, playSlotsDefaults, playerPlaySlots).minSlots,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && npx vitest run src/planning/groups.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/planning/groups.ts apps/worker/src/planning/groups.test.ts
git commit -m "feat(planning): teamrNamesForRound et orderMembersByDemand (groups.ts)"
```

---

### Task 2: `groups.ts` — `computeRoundsNeededForMembers` et `buildGroupsForBooking`

**Files:**
- Modify: `apps/worker/src/planning/groups.ts`
- Test: `apps/worker/src/planning/groups.test.ts`

**Interfaces:**
- Consumes: `buildPairsForGroupBooking` de `./pairing.js` (Task 1 déjà fait pour `teamrNamesForRound`/`orderMembersByDemand`)
- Produces: `computeRoundsNeededForMembers(orderedMembers: string[], playSlotsDefaults: PlaySlotsDefaults, playerPlaySlots: PlayerPlaySlotsMap): number`, `BuildGroupsResult { groups: Group[]; remainingSubstituteIds: string[]; warnings: string[] }`, `buildGroupsForBooking(expected: string[], substitutes: string[], playSlotsDefaults: PlaySlotsDefaults, playerPlaySlots: PlayerPlaySlotsMap): BuildGroupsResult`

- [ ] **Step 1: Write the failing test**

Ajouter à `apps/worker/src/planning/groups.test.ts` :

```typescript
import { buildGroupsForBooking, computeRoundsNeededForMembers } from "./groups.js";

describe("computeRoundsNeededForMembers", () => {
  it("groupe de 2, préférences par défaut (minSlots=2) : 2 rounds", () => {
    expect(computeRoundsNeededForMembers(["a", "b"], defaults, new Map())).toBe(2);
  });

  it("groupe de 2, un membre à minSlots=3 : 3 rounds (les 2 jouent toujours ensemble)", () => {
    const overrides = new Map<string, PlayerPlaySlots>([["a", { minSlots: 3, maxSlots: 3 }]]);
    expect(computeRoundsNeededForMembers(["a", "b"], defaults, overrides)).toBe(3);
  });

  it("groupe de 3, préférences par défaut : 3 rounds (calcul manuel utilisateur, régression 2026-08-23)", () => {
    expect(computeRoundsNeededForMembers(["a", "b", "c"], defaults, new Map())).toBe(3);
  });

  it("groupe de 3, un membre en position 0 à minSlots=3 : 4 rounds (pas 6 — pas d'arrondi à un cycle complet)", () => {
    const overrides = new Map<string, PlayerPlaySlots>([["a", { minSlots: 3, maxSlots: 3 }]]);
    // "a" doit être en position 0 (appelant : orderMembersByDemand avant cet appel).
    expect(computeRoundsNeededForMembers(["a", "b", "c"], defaults, overrides)).toBe(4);
  });
});

describe("buildGroupsForBooking", () => {
  it("effectif pair : groupes de 2, roundsNeeded = minSlots par défaut", () => {
    const result = buildGroupsForBooking(["a", "b", "c", "d"], [], defaults, new Map());
    expect(result.groups).toEqual([
      { members: ["a", "b"], roundsNeeded: 2 },
      { members: ["c", "d"], roundsNeeded: 2 },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.remainingSubstituteIds).toEqual([]);
  });

  it("effectif impair : le dernier joueur rejoint le 1er groupe, roundsNeeded recalculé pour le trio", () => {
    const result = buildGroupsForBooking(["a", "b", "c", "d", "e"], [], defaults, new Map());
    expect(result.groups).toEqual([
      { members: ["a", "b", "e"], roundsNeeded: 3 },
      { members: ["c", "d"], roundsNeeded: 2 },
    ]);
    expect(result.warnings.some((w) => w.includes("Effectif impair"))).toBe(true);
  });

  it("scénario régression 2026-08-23 : trio avec un membre à minSlots=3 → 4 rounds, pas 6", () => {
    const overrides = new Map<string, PlayerPlaySlots>([["a", { minSlots: 3, maxSlots: 3 }]]);
    const result = buildGroupsForBooking(["a", "b", "c"], [], defaults, overrides);
    expect(result.groups).toEqual([{ members: ["a", "b", "c"], roundsNeeded: 4 }]);
  });

  it("préférence individuelle sur une paire classique (bug annexe corrigé) : roundsNeeded suit le max des préférences", () => {
    const overrides = new Map<string, PlayerPlaySlots>([["a", { minSlots: 3, maxSlots: 3 }]]);
    const result = buildGroupsForBooking(["a", "b"], [], defaults, overrides);
    expect(result.groups).toEqual([{ members: ["a", "b"], roundsNeeded: 3 }]);
  });

  it("effectif impair avec prête-nom disponible : le prête-nom n'est jamais utilisé pour compléter l'effectif (règle 2026-08-02 héritée de pairing.ts)", () => {
    const result = buildGroupsForBooking(["a", "b", "c"], ["sub-1"], defaults, new Map());
    expect(result.groups).toEqual([{ members: ["a", "b", "c"], roundsNeeded: 3 }]);
    expect(result.remainingSubstituteIds).toEqual(["sub-1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && npx vitest run src/planning/groups.test.ts`
Expected: FAIL — `computeRoundsNeededForMembers`/`buildGroupsForBooking` n'existent pas encore.

- [ ] **Step 3: Write minimal implementation**

Ajouter à `apps/worker/src/planning/groups.ts` :

```typescript
import { buildPairsForGroupBooking } from "./pairing.js";

/**
 * Nombre de rounds à réserver pour que chaque membre du groupe atteigne son `minSlots` individuel
 * (`resolvePlayerPlaySlots`, préférences `/players`). Pas de suivi de présence round par round —
 * simulation du cycle round-robin fixe (`teamrNamesForRound`) jusqu'à ce que chaque position ait
 * atteint son quota. `orderedMembers` doit déjà être trié (voir `orderMembersByDemand`) pour un
 * groupe de 3 : mettre le plus exigeant en position 0 minimise le nombre de rounds.
 */
export function computeRoundsNeededForMembers(
  orderedMembers: string[],
  playSlotsDefaults: PlaySlotsDefaults,
  playerPlaySlots: PlayerPlaySlotsMap,
): number {
  const targets = orderedMembers.map((m) => resolvePlayerPlaySlots(m, playSlotsDefaults, playerPlaySlots).minSlots);
  if (orderedMembers.length <= 2) return Math.max(...targets);

  const cycle: Array<[number, number]> = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  const counts = [0, 0, 0];
  let rounds = 0;
  while (counts[0]! < targets[0]! || counts[1]! < targets[1]! || counts[2]! < targets[2]!) {
    const [a, b] = cycle[rounds % 3]!;
    counts[a] += 1;
    counts[b] += 1;
    rounds += 1;
  }
  return rounds;
}

export interface BuildGroupsResult {
  groups: Group[];
  /** Prête-noms disponibles pour le contrôle de plafond de résas/jour (groupBookingPlan.ts). */
  remainingSubstituteIds: string[];
  warnings: string[];
}

/**
 * Construit les groupes (2 ou 3 joueurs) à partir des paires (`buildPairsForGroupBooking`) : le
 * joueur en rotation (effectif impair, jamais plus d'un) rejoint le 1er groupe — court le mieux
 * classé en `courtPriority` (choix simple et déterministe, cf. spec §9).
 */
export function buildGroupsForBooking(
  expected: string[],
  substitutes: string[],
  playSlotsDefaults: PlaySlotsDefaults,
  playerPlaySlots: PlayerPlaySlotsMap,
): BuildGroupsResult {
  const { pairs, rotatingPlayerIds, remainingSubstituteIds } = buildPairsForGroupBooking(expected, substitutes);
  const warnings: string[] = [];
  const memberLists: string[][] = pairs.map((p) => [p.userId, p.partnerId]);

  if (rotatingPlayerIds.length > 0) {
    const rotator = rotatingPlayerIds[0]!;
    memberLists[0] = orderMembersByDemand([...memberLists[0]!, rotator], playSlotsDefaults, playerPlaySlots);
    warnings.push(
      `Effectif impair : ${rotator} intégré au groupe du court le mieux classé (rotation à ${memberLists[0].length}, les joueurs s'arrangent entre eux pour tourner).`,
    );
  }

  const groups: Group[] = memberLists.map((members) => ({
    members,
    roundsNeeded: computeRoundsNeededForMembers(members, playSlotsDefaults, playerPlaySlots),
  }));

  return { groups, remainingSubstituteIds, warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && npx vitest run src/planning/groups.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/planning/groups.ts apps/worker/src/planning/groups.test.ts
git commit -m "feat(planning): computeRoundsNeededForMembers et buildGroupsForBooking (groups.ts)"
```

---

### Task 3: `courtAssignment.ts` — exporter `orderByCourtPriority`

**Files:**
- Modify: `apps/worker/src/planning/courtAssignment.ts`

**Interfaces:**
- Produces: `orderByCourtPriority(slots: AvailableSlot[], courtPriority: number[]): AvailableSlot[]` (existe déjà en privé, devient exporté)

- [ ] **Step 1: Modifier la déclaration**

Dans `apps/worker/src/planning/courtAssignment.ts`, remplacer :

```typescript
function orderByCourtPriority(slots: AvailableSlot[], courtPriority: number[]): AvailableSlot[] {
```

par :

```typescript
export function orderByCourtPriority(slots: AvailableSlot[], courtPriority: number[]): AvailableSlot[] {
```

- [ ] **Step 2: Vérifier que les tests existants passent toujours**

Run: `cd apps/worker && npx vitest run src/planning/courtAssignment.test.ts`
Expected: PASS (aucun changement de comportement, juste l'export)

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/planning/courtAssignment.ts
git commit -m "refactor(planning): exporte orderByCourtPriority (réutilisé par scheduleGroupTimeline)"
```

---

### Task 4: `scheduleGroupTimeline.ts` — remplissage d'un groupe sur une timeline continue

**Files:**
- Create: `apps/worker/src/planning/scheduleGroupTimeline.ts`
- Test: `apps/worker/src/planning/scheduleGroupTimeline.test.ts`

**Interfaces:**
- Consumes: `Group`, `teamrNamesForRound` (Task 1-2), `orderByCourtPriority`, `AvailableSlot` (Task 3), `parseTeamrTime`, `slotStartDateIsoHeuristicParis` (`./teamrTime.js`, existant), `GroupBookingPlan` (`../mcp/resaSquash.js`, existant)
- Produces: `ScheduleGroupTimelineOptions`, `scheduleGroupTimeline(opts: ScheduleGroupTimelineOptions): GroupBookingPlan["proposedBookings"]`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/planning/scheduleGroupTimeline.test.ts
import { describe, expect, it } from "vitest";
import { scheduleGroupTimeline } from "./scheduleGroupTimeline.js";
import type { AvailableSlot } from "./courtAssignment.js";
import type { Group } from "./groups.js";

function makeSlots(courts: number[], beginTime: string, endTime: string): AvailableSlot[] {
  return courts.map((court) => ({ sessionId: `s-${court}-${beginTime}`, court, beginTime, endTime }));
}

function byTimeFrom(slots: AvailableSlot[]): Map<string, AvailableSlot[]> {
  const m = new Map<string, AvailableSlot[]>();
  for (const s of slots) {
    const arr = m.get(s.beginTime) ?? [];
    arr.push(s);
    m.set(s.beginTime, arr);
  }
  return m;
}

describe("scheduleGroupTimeline", () => {
  it("groupe de 2 : réserve roundsNeeded créneaux consécutifs sur le même court", () => {
    const slots = [...makeSlots([3, 4], "10H30", "11H15"), ...makeSlots([3, 4], "11H15", "12H00")];
    const byTime = byTimeFrom(slots);
    const warnings: string[] = [];
    const group: Group = { members: ["a", "b"], roundsNeeded: 2 };

    const bookings = scheduleGroupTimeline({
      group,
      startTime: "10H30",
      onDate: "2026-08-04",
      groupId: "g1",
      byTime,
      sortedTimes: ["10H30", "11H15"],
      claimedThisCall: new Set(),
      courtPriority: [4, 3, 2, 1],
      substituteQueue: [],
      existingDailyCounts: {},
      maxDailyReservationsPerPlayer: 2,
      apiUserId: null,
      warnings,
    });

    expect(bookings).toHaveLength(2);
    expect(bookings.every((b) => b.court === bookings[0]!.court)).toBe(true);
    expect(bookings.map((b) => b.slotTime)).toEqual(["10H30", "11H15"]);
    expect(bookings.every((b) => b.userId === "a" && b.partnerId === "b")).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("groupe de 3 : nomme les joueurs par round-robin (teamrNamesForRound), même court sur les 3 rounds", () => {
    const slots = [
      ...makeSlots([1], "10H30", "11H15"),
      ...makeSlots([1], "11H15", "12H00"),
      ...makeSlots([1], "12H00", "12H45"),
    ];
    const byTime = byTimeFrom(slots);
    const group: Group = { members: ["a", "b", "c"], roundsNeeded: 3 };

    const bookings = scheduleGroupTimeline({
      group,
      startTime: "10H30",
      onDate: "2026-08-04",
      groupId: "g1",
      byTime,
      sortedTimes: ["10H30", "11H15", "12H00"],
      claimedThisCall: new Set(),
      courtPriority: [1, 2, 3, 4],
      substituteQueue: [],
      existingDailyCounts: {},
      maxDailyReservationsPerPlayer: 2,
      apiUserId: null,
      warnings: [],
    });

    expect(bookings.map((b) => [b.userId, b.partnerId])).toEqual([
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
    expect(bookings.every((b) => b.court === 1)).toBe(true);
  });

  it("respecte le plafond quotidien : remplace le joueur au plafond par un prête-nom", () => {
    const slots = makeSlots([1], "10H30", "11H15");
    const byTime = byTimeFrom(slots);
    const warnings: string[] = [];
    const group: Group = { members: ["a", "b"], roundsNeeded: 1 };

    const bookings = scheduleGroupTimeline({
      group,
      startTime: "10H30",
      onDate: "2026-08-04",
      groupId: "g1",
      byTime,
      sortedTimes: ["10H30"],
      claimedThisCall: new Set(),
      courtPriority: [1, 2, 3, 4],
      substituteQueue: ["sub-1"],
      existingDailyCounts: { a: 2 },
      maxDailyReservationsPerPlayer: 2,
      apiUserId: null,
      warnings,
    });

    expect(bookings).toEqual([expect.objectContaining({ userId: "sub-1", partnerId: "b" })]);
    expect(warnings.some((w) => w.includes("remplacé par le prête-nom sub-1"))).toBe(true);
  });

  it("titulaire de la clé API jamais plafonné", () => {
    const slots = makeSlots([1], "10H30", "11H15");
    const byTime = byTimeFrom(slots);
    const group: Group = { members: ["vincent", "b"], roundsNeeded: 1 };

    const bookings = scheduleGroupTimeline({
      group,
      startTime: "10H30",
      onDate: "2026-08-04",
      groupId: "g1",
      byTime,
      sortedTimes: ["10H30"],
      claimedThisCall: new Set(),
      courtPriority: [1, 2, 3, 4],
      substituteQueue: [],
      existingDailyCounts: { vincent: 5 },
      maxDailyReservationsPerPlayer: 2,
      apiUserId: "vincent",
      warnings: [],
    });

    expect(bookings).toEqual([expect.objectContaining({ userId: "vincent", partnerId: "b" })]);
  });

  it("warning explicite si les créneaux disponibles ne suffisent pas à atteindre roundsNeeded", () => {
    const slots = makeSlots([1], "10H30", "11H15");
    const byTime = byTimeFrom(slots);
    const warnings: string[] = [];
    const group: Group = { members: ["a", "b"], roundsNeeded: 2 };

    const bookings = scheduleGroupTimeline({
      group,
      startTime: "10H30",
      onDate: "2026-08-04",
      groupId: "g1",
      byTime,
      sortedTimes: ["10H30"],
      claimedThisCall: new Set(),
      courtPriority: [1, 2, 3, 4],
      substituteQueue: [],
      existingDailyCounts: {},
      maxDailyReservationsPerPlayer: 2,
      apiUserId: null,
      warnings,
    });

    expect(bookings).toHaveLength(1);
    expect(warnings.some((w) => w.includes("1/2 round(s) réservé(s)"))).toBe(true);
  });

  it("respecte la continuité de court sur les rounds successifs même si un autre court est mieux classé", () => {
    const slots = [...makeSlots([3, 4], "10H30", "11H15"), ...makeSlots([3, 4], "11H15", "12H00")];
    const byTime = byTimeFrom(slots);
    const claimedThisCall = new Set<string>();
    // Le groupe A prend le court 4 (mieux classé) en premier.
    const groupA: Group = { members: ["a", "b"], roundsNeeded: 1 };
    scheduleGroupTimeline({
      group: groupA,
      startTime: "10H30",
      onDate: "2026-08-04",
      groupId: "g1",
      byTime,
      sortedTimes: ["10H30", "11H15"],
      claimedThisCall,
      courtPriority: [4, 3, 2, 1],
      substituteQueue: [],
      existingDailyCounts: {},
      maxDailyReservationsPerPlayer: 2,
      apiUserId: null,
      warnings: [],
    });
    // Le groupe B (2 rounds) doit rester sur le même court sur ses 2 rounds, pas sauter entre 3 et 4.
    const groupB: Group = { members: ["c", "d"], roundsNeeded: 2 };
    const bookingsB = scheduleGroupTimeline({
      group: groupB,
      startTime: "10H30",
      onDate: "2026-08-04",
      groupId: "g1",
      byTime,
      sortedTimes: ["10H30", "11H15"],
      claimedThisCall,
      courtPriority: [4, 3, 2, 1],
      substituteQueue: [],
      existingDailyCounts: {},
      maxDailyReservationsPerPlayer: 2,
      apiUserId: null,
      warnings: [],
    });
    expect(bookingsB.every((b) => b.court === bookingsB[0]!.court)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && npx vitest run src/planning/scheduleGroupTimeline.test.ts`
Expected: FAIL — le module `./scheduleGroupTimeline.js` n'existe pas.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/worker/src/planning/scheduleGroupTimeline.ts
import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import { orderByCourtPriority, type AvailableSlot } from "./courtAssignment.js";
import { teamrNamesForRound, type Group } from "./groups.js";
import { parseTeamrTime, slotStartDateIsoHeuristicParis } from "./teamrTime.js";

function availableSlotsAtTime(
  byTime: Map<string, AvailableSlot[]>,
  timeKey: string,
  claimedThisCall: ReadonlySet<string>,
): AvailableSlot[] {
  const at = byTime.get(timeKey);
  if (!at) return [];
  const byCourt = new Map<number, AvailableSlot>();
  for (const s of at) {
    if (claimedThisCall.has(s.sessionId)) continue;
    if (!byCourt.has(s.court)) byCourt.set(s.court, s);
  }
  return [...byCourt.values()];
}

export interface ScheduleGroupTimelineOptions {
  group: Group;
  /** Heure candidate — plancher horaire (les créneaux avant cette heure sont ignorés). */
  startTime: string;
  onDate: string;
  groupId: string;
  byTime: Map<string, AvailableSlot[]>;
  sortedTimes: string[];
  /** sessionId déjà retenus (par ce groupe ou un précédent dans le même appel) — mutée. */
  claimedThisCall: Set<string>;
  courtPriority: number[];
  /** Prête-noms disponibles — mutée à la consommation. */
  substituteQueue: string[];
  existingDailyCounts: Readonly<Record<string, number>>;
  maxDailyReservationsPerPlayer: number;
  apiUserId: string | null;
  warnings: string[];
}

/**
 * Réserve les `group.roundsNeeded` rounds d'un groupe (2 ou 3 joueurs) sur une timeline continue :
 * un seul court, conservé sur toute la durée (continuité), aux horaires disponibles à partir de
 * `startTime`. Nommage TeamR par round via un cycle round-robin fixe (`teamrNamesForRound`) — le
 * moteur ne calcule pas qui est physiquement présent à quel round, les joueurs s'arrangent entre
 * eux une fois le court réservé (simplification actée 2026-08-23).
 */
export function scheduleGroupTimeline(opts: ScheduleGroupTimelineOptions): GroupBookingPlan["proposedBookings"] {
  const {
    group,
    startTime,
    onDate,
    groupId,
    byTime,
    sortedTimes,
    claimedThisCall,
    courtPriority,
    substituteQueue,
    existingDailyCounts,
    maxDailyReservationsPerPlayer,
    apiUserId,
    warnings,
  } = opts;

  const bookings: GroupBookingPlan["proposedBookings"] = [];
  const startMinutes = parseTeamrTime(startTime) ?? 0;
  const timesFrom = sortedTimes.filter((t) => (parseTeamrTime(t) ?? 0) >= startMinutes);
  const groupSize = group.members.length === 3 ? 3 : 2;
  let assignedCourt: number | null = null;

  for (const t of timesFrom) {
    if (bookings.length >= group.roundsNeeded) break;

    const available = availableSlotsAtTime(byTime, t, claimedThisCall);
    if (available.length === 0) continue;

    const continuityMatch = assignedCourt != null ? available.find((s) => s.court === assignedCourt) : undefined;
    const slot = continuityMatch ?? orderByCourtPriority(available, courtPriority)[0];
    if (!slot) continue;

    const roundIndex = bookings.length;
    const [i, j] = teamrNamesForRound(groupSize, roundIndex);
    let userId = group.members[i]!;
    let partnerId = group.members[j]!;

    let blocked = false;
    for (const role of ["userId", "partnerId"] as const) {
      const candidateId = role === "userId" ? userId : partnerId;
      if (candidateId === apiUserId) continue;
      const already =
        (existingDailyCounts[candidateId] ?? 0) +
        bookings.filter((b) => b.userId === candidateId || b.partnerId === candidateId).length;
      if (already < maxDailyReservationsPerPlayer) continue;

      const sub = substituteQueue.shift();
      if (sub) {
        if (role === "userId") userId = sub;
        else partnerId = sub;
        warnings.push(
          `${candidateId} : plafond ${maxDailyReservationsPerPlayer} résas ce jour atteint — remplacé par le prête-nom ${sub} pour cette paire (${slot.beginTime}).`,
        );
      } else {
        warnings.push(
          `${candidateId} : plafond ${maxDailyReservationsPerPlayer} résas ce jour atteint — réservation ignorée pour cette paire (${slot.beginTime}), aucun prête-nom disponible.`,
        );
        blocked = true;
      }
    }
    if (blocked) continue;

    const startDate = slotStartDateIsoHeuristicParis(onDate, slot.beginTime);
    if (!startDate) continue;

    bookings.push({
      sessionId: slot.sessionId,
      userId,
      partnerId,
      startDate,
      court: slot.court,
      slotTime: slot.beginTime,
      slotEndTime: slot.endTime,
      groupId,
    });
    claimedThisCall.add(slot.sessionId);
    assignedCourt = slot.court;
  }

  if (bookings.length < group.roundsNeeded) {
    warnings.push(
      `Groupe ${group.members.join("+")} : ${bookings.length}/${group.roundsNeeded} round(s) réservé(s) — créneaux insuffisants à partir de ${startTime}.`,
    );
  }

  return bookings;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && npx vitest run src/planning/scheduleGroupTimeline.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/planning/scheduleGroupTimeline.ts apps/worker/src/planning/scheduleGroupTimeline.test.ts
git commit -m "feat(planning): scheduleGroupTimeline (remplissage d'un groupe sur timeline continue)"
```

---

### Task 5: `sessionExtension.ts` — simplifier `OngoingSession` et `extendSessionForLateJoiners`

**Files:**
- Modify: `apps/worker/src/planning/sessionExtension.ts`
- Test: `apps/worker/src/planning/sessionExtension.test.ts` (nouveau)

**Interfaces:**
- Consumes: `teamrNamesForRound`, `orderMembersByDemand`, `computeRoundsNeededForMembers` (Task 1-2), `PlayerPlaySlotsMap`/`PlaySlotsDefaults` (existant)
- Produces: `OngoingSession { court: number; anchorStartTime: string; members: string[]; roundsBooked: number; roundsNeeded: number; proposedBookings: GroupBookingPlan["proposedBookings"]; groupIndex: number }`, `buildOngoingSessionsFromPlan(plan, anchorStartTime, groupIndex, confirmedPlayerIds, playSlotsDefaults, playerPlaySlots): OngoingSession[]`, `ExtendSessionOptions` (sans `slotsPerPlayer`, avec `playSlotsDefaults`/`playerPlaySlots`), `extendSessionForLateJoiners(opts): GroupBookingPlan["proposedBookings"]`, `findMergeableSession` (inchangé sauf `session.players`→`session.members`), `appendBookingsToGroupPlan` (inchangé)

**Note pour l'implémenteur :** ce fichier passe d'environ 445 à ~300 lignes. Les fonctions `lastSlotEndTime`, `sessionCoversJoinTime`, `withinAvailabilityWindow`, `teamrCountForPlayer`, `findSlotOnCourt`, `nextSlotBeginTime` sont **conservées sans aucun changement** — seules `OngoingSession`, `buildOngoingSessionsFromPlan`, `extendSessionForLateJoiners`, `pickTeamrNamesForExtension` (supprimée) et `findMergeableSession` (renommage `players`→`members`) changent.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/planning/sessionExtension.test.ts
import { describe, expect, it } from "vitest";
import {
  buildOngoingSessionsFromPlan,
  extendSessionForLateJoiners,
  findMergeableSession,
  type OngoingSession,
} from "./sessionExtension.js";
import type { AvailableSlot } from "./courtAssignment.js";
import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import { DEFAULT_PLAY_SLOTS } from "./playerPlaySlots.js";

function makeSlots(courts: number[], beginTime: string, endTime: string): AvailableSlot[] {
  return courts.map((court) => ({ sessionId: `s-${court}-${beginTime}`, court, beginTime, endTime }));
}

function basePlan(bookings: GroupBookingPlan["proposedBookings"]): GroupBookingPlan {
  return {
    dryRun: true,
    proposedBookings: bookings,
    warnings: [],
    meta: {
      courtsNeeded: 1,
      roundsPlanned: bookings.length,
      dryRun: true,
      groupLabel: "g1",
      recurringWeekday: 2,
      recurringStartTime: "10H30",
      slotsPerPlayer: 2,
      groupMinSlotsPerPlayer: 2,
      groupMaxSlotsPerPlayer: 2,
      pairCount: 1,
    },
  };
}

describe("buildOngoingSessionsFromPlan", () => {
  it("extrait members (joueurs confirmés réels, pas les prête-noms) et roundsNeeded par court", () => {
    const plan = basePlan([
      {
        sessionId: "s1",
        userId: "a",
        partnerId: "sub-1",
        startDate: "2026-08-04T10:30:00+02:00",
        court: 3,
        slotTime: "10H30",
        slotEndTime: "11H15",
        groupId: "g1",
      },
    ]);
    const sessions = buildOngoingSessionsFromPlan(plan, "10H30", 0, ["a"], DEFAULT_PLAY_SLOTS, new Map());
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.members).toEqual(["a"]);
    expect(sessions[0]!.roundsBooked).toBe(1);
    expect(sessions[0]!.roundsNeeded).toBe(2);
  });

  it("plan vide → aucune session", () => {
    expect(buildOngoingSessionsFromPlan(basePlan([]), "10H30", 0, ["a"], DEFAULT_PLAY_SLOTS, new Map())).toEqual([]);
  });
});

describe("extendSessionForLateJoiners", () => {
  it("ajoute un late joiner et prolonge jusqu'à ce que le groupe atteigne roundsNeeded (3 pour un trio par défaut)", () => {
    const availableSlots = [
      ...makeSlots([1], "10H30", "11H15"),
      ...makeSlots([1], "11H15", "12H00"),
      ...makeSlots([1], "12H00", "12H45"),
    ];
    const session: OngoingSession = {
      court: 1,
      anchorStartTime: "10H30",
      members: ["a", "b"],
      roundsBooked: 2,
      roundsNeeded: 2,
      proposedBookings: [
        {
          sessionId: "s-1-10H30",
          userId: "a",
          partnerId: "b",
          startDate: "2026-08-04T10:30:00+02:00",
          court: 1,
          slotTime: "10H30",
          slotEndTime: "11H15",
          groupId: "g1",
        },
        {
          sessionId: "s-1-11H15",
          userId: "a",
          partnerId: "b",
          startDate: "2026-08-04T11:15:00+02:00",
          court: 1,
          slotTime: "11H15",
          slotEndTime: "12H00",
          groupId: "g1",
        },
      ],
      groupIndex: 0,
    };
    const usedSessionIds = new Set(["s-1-10H30", "s-1-11H15"]);
    const warnings: string[] = [];

    const extra = extendSessionForLateJoiners({
      session,
      lateJoinerIds: ["c"],
      joinTime: "10H30",
      targetDate: "2026-08-04",
      groupId: "g1",
      maxPlayersPerCourt: 3,
      maxDailyReservationsPerPlayer: 2,
      availabilityWindowHours: 3,
      availableSlots,
      usedSessionIds,
      substituteQueue: [],
      existingDailyCounts: {},
      apiUserId: null,
      playSlotsDefaults: DEFAULT_PLAY_SLOTS,
      playerPlaySlots: new Map(),
      warnings,
    });

    expect(extra).toHaveLength(1);
    expect(extra[0]).toEqual(expect.objectContaining({ slotTime: "12H00", court: 1, userId: "b", partnerId: "c" }));
    expect(session.members).toEqual(["a", "b", "c"]);
    expect(session.roundsNeeded).toBe(3);
  });

  it("plafond maxPlayersPerCourt : n'ajoute pas de late joiner au-delà", () => {
    const session: OngoingSession = {
      court: 1,
      anchorStartTime: "10H30",
      members: ["a", "b", "c"],
      roundsBooked: 3,
      roundsNeeded: 3,
      proposedBookings: [],
      groupIndex: 0,
    };
    const warnings: string[] = [];
    const extra = extendSessionForLateJoiners({
      session,
      lateJoinerIds: ["d"],
      joinTime: "10H30",
      targetDate: "2026-08-04",
      groupId: "g1",
      maxPlayersPerCourt: 3,
      maxDailyReservationsPerPlayer: 2,
      availabilityWindowHours: 3,
      availableSlots: [],
      usedSessionIds: new Set(),
      substituteQueue: [],
      existingDailyCounts: {},
      apiUserId: null,
      playSlotsDefaults: DEFAULT_PLAY_SLOTS,
      playerPlaySlots: new Map(),
      warnings,
    });
    expect(extra).toEqual([]);
    expect(session.members).toEqual(["a", "b", "c"]);
    expect(warnings.some((w) => w.includes("impossible d'ajouter d"))).toBe(true);
  });
});

describe("findMergeableSession", () => {
  it("trouve une session dans la fenêtre de disponibilité avec de la place", () => {
    const session: OngoingSession = {
      court: 1,
      anchorStartTime: "10H30",
      members: ["a", "b"],
      roundsBooked: 1,
      roundsNeeded: 2,
      proposedBookings: [
        {
          sessionId: "s1",
          userId: "a",
          partnerId: "b",
          startDate: "2026-08-04T10:30:00+02:00",
          court: 1,
          slotTime: "10H30",
          slotEndTime: "11H15",
          groupId: "g1",
        },
      ],
      groupIndex: 0,
    };
    expect(findMergeableSession([session], "11H15", 1, 3, 3)).toBe(session);
    expect(findMergeableSession([session], "11H15", 2, 3, 3)).toBeNull(); // dépasse maxPlayersPerCourt
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && npx vitest run src/planning/sessionExtension.test.ts`
Expected: FAIL (signatures actuelles différentes — `players`/`pairUserId` au lieu de `members`, pas de `playSlotsDefaults`/`playerPlaySlots`).

- [ ] **Step 3: Write the implementation**

Remplacer entièrement `apps/worker/src/planning/sessionExtension.ts` par :

```typescript
// apps/worker/src/planning/sessionExtension.ts
import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import type { AvailableSlot } from "./courtAssignment.js";
import { computeRoundsNeededForMembers, orderMembersByDemand, teamrNamesForRound } from "./groups.js";
import type { PlayerPlaySlotsMap, PlaySlotsDefaults } from "./playerPlaySlots.js";
import { formatTeamrTimeFromMinutes, parseTeamrTime, slotStartDateIsoHeuristicParis } from "./teamrTime.js";

export interface OngoingSession {
  court: number;
  /** Heure candidate qui a ouvert la session (pour la fenêtre availabilityWindowHours). */
  anchorStartTime: string;
  /** Joueurs réels confirmés sur ce court (pas les prête-noms TeamR) — 2 ou 3. */
  members: string[];
  /** Nombre de rounds déjà réservés sur ce court. */
  roundsBooked: number;
  /** Cible actuelle (recalculée si des late joiners rejoignent via extendSessionForLateJoiners). */
  roundsNeeded: number;
  proposedBookings: GroupBookingPlan["proposedBookings"];
  groupIndex: number;
}

function lastSlotEndTime(bookings: GroupBookingPlan["proposedBookings"], court: number): string | null {
  let best: string | null = null;
  let bestMin = -1;
  for (const b of bookings) {
    if (b.court !== court) continue;
    const end = parseTeamrTime(b.slotEndTime);
    if (end != null && end > bestMin) {
      bestMin = end;
      best = b.slotEndTime;
    }
  }
  return best;
}

function sessionCoversJoinTime(session: OngoingSession, timeKey: string): boolean {
  const joinMin = parseTeamrTime(timeKey);
  if (joinMin == null) return false;
  const anchor = parseTeamrTime(session.anchorStartTime);
  if (anchor == null) return false;
  if (joinMin < anchor) return false;
  const lastEnd = lastSlotEndTime(session.proposedBookings, session.court);
  if (!lastEnd) return true;
  const endMin = parseTeamrTime(lastEnd);
  return endMin != null && joinMin <= endMin;
}

function withinAvailabilityWindow(anchorStartTime: string, timeKey: string, windowHours: number): boolean {
  const anchor = parseTeamrTime(anchorStartTime);
  const t = parseTeamrTime(timeKey);
  if (anchor == null || t == null) return true;
  return t <= anchor + windowHours * 60;
}

/** Extrait une session par court à partir d'un plan calculé pour une heure candidate. */
export function buildOngoingSessionsFromPlan(
  plan: GroupBookingPlan,
  anchorStartTime: string,
  groupIndex: number,
  confirmedPlayerIds: string[],
  playSlotsDefaults: PlaySlotsDefaults,
  playerPlaySlots: PlayerPlaySlotsMap,
): OngoingSession[] {
  if (plan.proposedBookings.length === 0) return [];

  const byCourt = new Map<number, GroupBookingPlan["proposedBookings"]>();
  for (const b of plan.proposedBookings) {
    const arr = byCourt.get(b.court) ?? [];
    arr.push(b);
    byCourt.set(b.court, arr);
  }

  const confirmedSet = new Set(confirmedPlayerIds);
  const sessions: OngoingSession[] = [];
  for (const [court, bookings] of byCourt) {
    const sorted = [...bookings].sort(
      (a, b) => (parseTeamrTime(a.slotTime) ?? 0) - (parseTeamrTime(b.slotTime) ?? 0),
    );
    // Seuls les joueurs réellement réservés sur CE court (pas tout le groupe, qui peut couvrir
    // plusieurs courts en //) — sinon un late joiner apparaît déjà "présent" sur chaque court à
    // la fois (régression 2026-08-23 : 7 joueurs / 3 courts, le 7e disparaissait du plan).
    const bookedIds = sorted.flatMap((b) => [b.userId, b.partnerId]).filter((id): id is string => id != null);
    const members = [...new Set(bookedIds.filter((id) => confirmedSet.has(id)))];
    sessions.push({
      court,
      anchorStartTime,
      members,
      roundsBooked: sorted.length,
      roundsNeeded: computeRoundsNeededForMembers(members, playSlotsDefaults, playerPlaySlots),
      proposedBookings: sorted,
      groupIndex,
    });
  }
  return sessions;
}

function teamrCountForPlayer(bookings: GroupBookingPlan["proposedBookings"], playerId: string): number {
  let n = 0;
  for (const b of bookings) {
    if (b.userId === playerId || b.partnerId === playerId) n += 1;
  }
  return n;
}

function findSlotOnCourt(
  availableSlots: AvailableSlot[],
  usedSessionIds: ReadonlySet<string>,
  court: number,
  beginTime: string,
): AvailableSlot | null {
  for (const s of availableSlots) {
    if (s.court !== court || s.beginTime !== beginTime) continue;
    if (usedSessionIds.has(s.sessionId)) continue;
    return s;
  }
  return null;
}

function nextSlotBeginTime(afterEndTime: string): string | null {
  const endMin = parseTeamrTime(afterEndTime);
  if (endMin == null) return null;
  return formatTeamrTimeFromMinutes(endMin);
}

export interface ExtendSessionOptions {
  session: OngoingSession;
  lateJoinerIds: string[];
  joinTime: string;
  targetDate: string;
  groupId: string;
  maxPlayersPerCourt: number;
  /** Plafond TeamR groupe (rule.maxDailyReservationsPerPlayer) — pas le quota effectif joueur. */
  maxDailyReservationsPerPlayer: number;
  availabilityWindowHours: number;
  availableSlots: AvailableSlot[];
  usedSessionIds: Set<string>;
  /** Prête-noms encore disponibles (volontaires + substituteBookers), mutés à la consommation. */
  substituteQueue: string[];
  existingDailyCounts: Readonly<Record<string, number>>;
  apiUserId: string | null;
  playSlotsDefaults: PlaySlotsDefaults;
  playerPlaySlots: PlayerPlaySlotsMap;
  warnings: string[];
}

/**
 * Ajoute des late joiners à une session en cours et prolonge jusqu'à ce que le groupe élargi
 * atteigne son nouveau `roundsNeeded` (recalculé, `groups.ts`). Ne dépasse jamais
 * maxDailyReservationsPerPlayer sur une ligne TeamR : au-delà, bascule sur prête-nom. Nommage par
 * round via le cycle round-robin fixe (`teamrNamesForRound`) — pas de suivi de qui est présent à
 * quel round, les joueurs s'arrangent entre eux (simplification actée 2026-08-23).
 */
export function extendSessionForLateJoiners(opts: ExtendSessionOptions): GroupBookingPlan["proposedBookings"] {
  const {
    session,
    lateJoinerIds,
    joinTime,
    targetDate,
    groupId,
    maxPlayersPerCourt,
    maxDailyReservationsPerPlayer,
    availabilityWindowHours,
    availableSlots,
    usedSessionIds,
    substituteQueue,
    existingDailyCounts,
    apiUserId,
    playSlotsDefaults,
    playerPlaySlots,
    warnings,
  } = opts;

  const rawMembers = [...session.members];
  for (const id of lateJoinerIds) {
    if (rawMembers.includes(id)) continue;
    if (rawMembers.length >= maxPlayersPerCourt) {
      warnings.push(`Court ${session.court} : impossible d'ajouter ${id} (plafond ${maxPlayersPerCourt} joueurs/court).`);
      continue;
    }
    rawMembers.push(id);
  }
  const members = orderMembersByDemand(rawMembers, playSlotsDefaults, playerPlaySlots);
  session.members = members;
  const roundsNeeded = computeRoundsNeededForMembers(members, playSlotsDefaults, playerPlaySlots);
  session.roundsNeeded = roundsNeeded;

  if (members.length > 2) {
    warnings.push(
      `Court ${session.court} : rotation à ${members.length} (${members.join(", ")}) — ${roundsNeeded} round(s) au total (les joueurs s'arrangent entre eux pour tourner).`,
    );
  }

  const groupSize = members.length === 3 ? 3 : 2;
  const added: GroupBookingPlan["proposedBookings"] = [];
  const allBookings = () => [...session.proposedBookings, ...added];
  let lastEnd = lastSlotEndTime(allBookings(), session.court) ?? joinTime;

  while (session.roundsBooked + added.length < roundsNeeded) {
    const nextBegin = nextSlotBeginTime(lastEnd);
    if (!nextBegin) break;
    if (!withinAvailabilityWindow(session.anchorStartTime, nextBegin, availabilityWindowHours)) {
      warnings.push(
        `Court ${session.court} : prolongation arrêtée à ${nextBegin} (hors fenêtre ${availabilityWindowHours}h depuis ${session.anchorStartTime}).`,
      );
      break;
    }

    const roundIndex = session.roundsBooked + added.length;
    const [i, j] = teamrNamesForRound(groupSize, roundIndex);
    let userId = members[i]!;
    let partnerId = members[j]!;

    let blocked = false;
    for (const role of ["userId", "partnerId"] as const) {
      const candidateId = role === "userId" ? userId : partnerId;
      if (candidateId === apiUserId) continue;
      const already = (existingDailyCounts[candidateId] ?? 0) + teamrCountForPlayer(allBookings(), candidateId);
      if (already < maxDailyReservationsPerPlayer) continue;

      const sub = substituteQueue.shift();
      if (sub) {
        if (role === "userId") userId = sub;
        else partnerId = sub;
        warnings.push(
          `Court ${session.court} : prolongation TeamR avec prête-nom ${sub} (${candidateId} au plafond ${maxDailyReservationsPerPlayer} résas/jour).`,
        );
      } else {
        warnings.push(
          `Court ${session.court} : impossible de prolonger — ${candidateId} au plafond ${maxDailyReservationsPerPlayer} résas/jour et aucun prête-nom disponible.`,
        );
        blocked = true;
      }
    }
    if (blocked) break;

    const slot = findSlotOnCourt(availableSlots, usedSessionIds, session.court, nextBegin);
    if (!slot) {
      warnings.push(`Court ${session.court} : pas de créneau libre à ${nextBegin} pour prolonger la rotation.`);
      break;
    }

    const startDate = slotStartDateIsoHeuristicParis(targetDate, slot.beginTime);
    if (!startDate) break;

    added.push({
      sessionId: slot.sessionId,
      userId,
      partnerId,
      startDate,
      court: session.court,
      slotTime: slot.beginTime,
      slotEndTime: slot.endTime,
      groupId,
    });
    usedSessionIds.add(slot.sessionId);
    lastEnd = slot.endTime;
  }

  session.proposedBookings.push(...added);
  return added;
}

/** Cherche une session fusionnable pour des joueurs orphelins à une heure candidate tardive. */
export function findMergeableSession(
  sessions: OngoingSession[],
  orphanJoinTime: string,
  orphanCount: number,
  maxPlayersPerCourt: number,
  availabilityWindowHours: number,
): OngoingSession | null {
  for (const session of sessions) {
    if (!withinAvailabilityWindow(session.anchorStartTime, orphanJoinTime, availabilityWindowHours)) continue;
    if (!sessionCoversJoinTime(session, orphanJoinTime)) continue;
    if (session.members.length + orphanCount > maxPlayersPerCourt) continue;
    return session;
  }
  return null;
}

/** Fusionne des réservations dans le plan d'un groupe et met à jour meta.rotatingPlayerIds. */
export function appendBookingsToGroupPlan(
  plan: GroupBookingPlan,
  extra: GroupBookingPlan["proposedBookings"],
  rotatingPlayerIds: string[],
): void {
  plan.proposedBookings.push(...extra);
  plan.meta.rotatingPlayerIds = rotatingPlayerIds;
  plan.meta.roundsPlanned += extra.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && npx vitest run src/planning/sessionExtension.test.ts`
Expected: PASS (5 tests). **Ne pas s'arrêter là** — ce fichier casse la compilation de `planJob.ts` et `groupBookingPlan.ts` (anciens appels avec `slotsPerPlayer`/`session.players`) : c'est normal, corrigé aux Tasks 6-7.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/planning/sessionExtension.ts apps/worker/src/planning/sessionExtension.test.ts
git commit -m "refactor(planning): sessionExtension.ts — rounds globaux au lieu de présence pondérée"
```

---

### Task 6: `planJob.ts` — adapter les appels au nouveau modèle

**Files:**
- Modify: `apps/worker/src/planning/planJob.ts`

**Interfaces:**
- Consumes: `OngoingSession` (`members` au lieu de `players`/`pairUserId`), `buildOngoingSessionsFromPlan`/`extendSessionForLateJoiners` avec les nouvelles signatures (Task 5)

- [ ] **Step 1: Localiser les appels à adapter**

Run: `grep -n "buildOngoingSessionsFromPlan\|extendSessionForLateJoiners\|\.players\b\|pairUserId\|pairPartnerId\|playerJoinTimes\|slotsPerPlayer:" apps/worker/src/planning/planJob.ts`

Trois zones à corriger (recherchez le texte exact, les numéros de ligne peuvent avoir bougé depuis la lecture initiale) :

1. L'appel à `recordSessionsFromGroup`/`buildOngoingSessionsFromPlan` (autour de la ligne 75-85) : ajouter les paramètres `playSlotsDefaults`/`playerPlaySlots` déjà présents dans la fonction englobante (`playSlotsOptions?.defaults ?? DEFAULT_PLAY_SLOTS` et `playerPlaySlots` construits plus haut dans `planJobBookings`).
2. L'appel à `extendSessionForLateJoiners` dans la branche `confirmedPlayerIds.length < bookingRule.minPlayersPerCourt` (autour de la ligne 313-347) : retirer `slotsPerPlayer: bookingRule.maxReservationsPerPlayer`, ajouter `playSlotsDefaults`/`playerPlaySlots` (déjà en portée).
3. L'appel à `appendBookingsToGroupPlan(anchorGroup.plan, extra, mergeTarget.rotatingPlayerIds)` : remplacer `mergeTarget.rotatingPlayerIds` (champ supprimé) par `mergeTarget.members.slice(2)`.

- [ ] **Step 2: Appliquer les corrections**

Pour la zone 1 (`recordSessionsFromGroup`), modifier sa signature et son corps :

```typescript
function recordSessionsFromGroup(
  plan: GroupBookingPlan,
  startTime: string,
  groupIndex: number,
  confirmedPlayerIds: string[],
  playSlotsDefaults: PlaySlotsDefaults,
  playerPlaySlots: PlayerPlaySlotsMap,
  ongoingSessions: OngoingSession[],
): void {
  for (const session of buildOngoingSessionsFromPlan(
    plan,
    startTime,
    groupIndex,
    confirmedPlayerIds,
    playSlotsDefaults,
    playerPlaySlots,
  )) {
    ongoingSessions.push(session);
  }
}
```

Et adapter son unique appelant (recherchez `recordSessionsFromGroup(` dans le fichier) pour passer `playSlotsDefaults` et `playerPlaySlots` (déjà calculés dans `planJobBookings`, juste avant la boucle `for (const startTime of bookingRule.candidateStartTimes)`).

Pour la zone 2, dans l'appel à `extendSessionForLateJoiners` :

```typescript
const extra = extendSessionForLateJoiners({
  session: mergeTarget,
  lateJoinerIds: confirmedPlayerIds,
  joinTime: startTime,
  targetDate,
  groupId: bookingRule.resaSquashGroupId,
  maxPlayersPerCourt: bookingRule.maxPlayersPerCourt,
  maxDailyReservationsPerPlayer: bookingRule.maxDailyReservationsPerPlayer,
  availabilityWindowHours: bookingRule.availabilityWindowHours,
  availableSlots,
  usedSessionIds,
  substituteQueue,
  existingDailyCounts: Object.fromEntries(playerDailyCounts),
  apiUserId,
  playSlotsDefaults,
  playerPlaySlots,
  warnings: mergeWarnings,
});
```

(Retrait de `slotsPerPlayer: bookingRule.maxReservationsPerPlayer` ; `playSlotsDefaults`/`playerPlaySlots` déjà en portée dans cette fonction — mêmes variables que la zone 1.)

Pour la zone 3 :

```typescript
appendBookingsToGroupPlan(anchorGroup.plan, extra, mergeTarget.members.slice(2));
```

- [ ] **Step 3: Vérifier que le fichier compile**

Run: `./node_modules/.bin/tsc -p apps/worker/tsconfig.build.json --noEmit`
Expected: erreurs uniquement dans `groupBookingPlan.ts` (Task 7, pas encore fait) — `planJob.ts` doit compiler sans erreur à ce stade. Si `planJob.ts` a encore des erreurs, corriger avant de continuer (imports `PlaySlotsDefaults`/`PlayerPlaySlotsMap` déjà présents en haut du fichier — vérifier avec `grep -n "^import" apps/worker/src/planning/planJob.ts`).

- [ ] **Step 4: Lancer les tests de planJob (attendu : échecs à corriger)**

Run: `cd apps/worker && npx vitest run src/planning/planJob.test.ts`
Expected: des échecs sont possibles si des assertions vérifient le texte exact d'anciens warnings (ex. mentionnant "temps de jeu effectif" au lieu de "rotation à N"). Pour chaque échec :
- Si l'échec porte sur le **contenu fonctionnel** (quelles réservations, quels joueurs) : c'est une vraie régression, investiguer avant de continuer.
- Si l'échec porte uniquement sur le **texte d'un message de warning** : mettre à jour la chaîne attendue dans le test pour refléter le nouveau texte produit par `sessionExtension.ts` (Task 5).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/planning/planJob.ts apps/worker/src/planning/planJob.test.ts
git commit -m "fix(planning): adapte planJob.ts au nouveau modèle OngoingSession/extendSessionForLateJoiners"
```

---

### Task 7: `groupBookingPlan.ts` — dispatcher cas courant / cas file d'attente

**Files:**
- Modify: `apps/worker/src/planning/groupBookingPlan.ts`
- Test: `apps/worker/src/planning/groupBookingPlan.test.ts`

**Interfaces:**
- Consumes: `buildGroupsForBooking` (Task 2), `scheduleGroupTimeline` (Task 4), `buildOngoingSessionsFromPlan`/`extendSessionForLateJoiners` nouvelles signatures (Task 5)
- Produces: `computeGroupBookingPlan` (signature externe **inchangée** — `ComputeGroupBookingPlanInput` ne change pas)

**Note pour l'implémenteur :** `computeGroupBookingPlan` devient un dispatcher de ~30 lignes. La logique "cas file d'attente" (`pairs.length > courtsNeeded`) est le corps **actuel** de la fonction (couches + extension post-hoc), déplacé tel quel dans `computeQueueingCasePlan` avec seulement des ajustements mécaniques d'appel à `buildOngoingSessionsFromPlan`/`extendSessionForLateJoiners` (nouvelles signatures, Task 5) — aucun changement de logique de couches.

- [ ] **Step 1: Write the failing tests (nouveaux scénarios)**

Ajouter à `apps/worker/src/planning/groupBookingPlan.test.ts` (après le dernier test existant, avant le `});` final de `describe("computeGroupBookingPlan", ...)`) :

```typescript
  it("régression 2026-08-23 : 7 joueurs, 3 courts, préférences par défaut — 3 rounds (pas 4), tous les groupes en parallèle", () => {
    const availableSlots = [
      ...makeSlots([1, 2, 3], "10H30", "11H15"),
      ...makeSlots([1, 2, 3], "11H15", "12H00"),
      ...makeSlots([1, 2, 3], "12H00", "12H45"),
    ];
    const plan = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["a", "b", "c", "d", "e", "f", "g"],
        startTime: "10H30",
        availableSlots,
      }),
    );

    // Le 7e joueur (rotation) doit apparaître dans le plan.
    expect(plan.proposedBookings.some((b) => b.userId === "g" || b.partnerId === "g")).toBe(true);
    // 3 rounds au total : 3+3+3 = 9 réservations (3 courts × 3 rounds), pas 4 rounds.
    expect(plan.proposedBookings).toHaveLength(9);
    expect(new Set(plan.proposedBookings.map((b) => b.slotTime))).toEqual(new Set(["10H30", "11H15", "12H00"]));
  });

  it("préférence individuelle sur une paire classique (bug annexe corrigé) : le membre à minSlots=3 obtient 3 rounds", () => {
    const availableSlots = [
      ...makeSlots([4], "10H30", "11H15"),
      ...makeSlots([4], "11H15", "12H00"),
      ...makeSlots([4], "12H00", "12H45"),
    ];
    const plan = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["a", "b"],
        startTime: "10H30",
        availableSlots,
        playerPlaySlots: new Map([["a", { minSlots: 3, maxSlots: 3 }]]),
      }),
    );
    expect(plan.proposedBookings).toHaveLength(3);
    expect(plan.proposedBookings.every((b) => b.userId === "a" && b.partnerId === "b")).toBe(true);
  });
```

Note : `baseInput` (déjà défini en tête du fichier de test) doit inclure `playerPlaySlots: undefined` par défaut dans son objet retourné, ou laisser l'appelant le passer en override comme dans le 2e test ci-dessus — vérifier que `ComputeGroupBookingPlanInput` accepte bien `playerPlaySlots?`/`playSlotsDefaults?` (déjà le cas, inchangé).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && npx vitest run src/planning/groupBookingPlan.test.ts`
Expected: les 2 nouveaux tests FAIL (comportement encore basé sur l'ancienne logique) ; les tests existants passent toujours.

- [ ] **Step 3: Restructurer `computeGroupBookingPlan`**

Dans `apps/worker/src/planning/groupBookingPlan.ts`, le fichier actuel a cette structure (vérifiée à jour au moment d'écrire ce plan — relire le fichier avant de commencer, il a pu bouger) :

```
export function computeGroupBookingPlan(input: ...): GroupBookingPlan {
  const warnings: string[] = [];                                    // L105
  const { pairs, rotatingPlayerIds, remainingSubstituteIds } = ...;  // L107-110
  const rotatingSet = new Set(rotatingPlayerIds);                    // L111
  const substituteQueue = [...remainingSubstituteIds];               // L112
  if (rotatingPlayerIds.length > 0) { warnings.push(`Effectif impair : rotation sur court...`); }  // L113-117
  const playerSet = new Set<string>(); ... (calcul playerSet)        // L119-124
  const courtsNeededRaw = ...; const hardCap = ...; const courtsNeeded = ...;  // L126-131
  const startMinutes = ...; const filteredSlots = ...;               // L133-140
  const byTime = ...; const sortedTimes = ...; const emptyMeta = {...};  // L142-156
  if (sortedTimes.length === 0) { ...; return {...}; }               // L157-160
  const proposed: ProposedSlot[] = [];                               // L162
  ... (boucle planLayers, warning "chaque joueur ≥N", extension rotation) ...
  return { dryRun: true, proposedBookings: proposedWithMeta, warnings, meta: {...} };  // L373-378
}
```

1. Ajouter les imports :

```typescript
import { buildGroupsForBooking } from "./groups.js";
import { scheduleGroupTimeline } from "./scheduleGroupTimeline.js";
```

2. **Couper** tout le contenu allant de la ligne `const rotatingSet = new Set(rotatingPlayerIds);` (L111) **jusqu'à la fin de la fonction** (le dernier `return { dryRun: true, proposedBookings: proposedWithMeta, ... };`) — ça inclut le warning "Effectif impair", `substituteQueue`, la boucle `planLayers`, le warning "chaque joueur ≥N", le bloc d'extension de rotation, et le `return` final.

3. Coller ce contenu coupé dans une nouvelle fonction en bas du fichier, avec cette signature :

```typescript
function computeQueueingCasePlan(
  input: ComputeGroupBookingPlanInput,
  pairs: GroupBookingPair[],
  rotatingPlayerIds: string[],
  remainingSubstituteIds: string[],
  playerSet: Set<string>,
  courtsNeeded: number,
  byTime: Map<string, AvailableSlot[]>,
  sortedTimes: string[],
  emptyMeta: GroupBookingPlan["meta"],
): GroupBookingPlan {
  const warnings: string[] = [];
  // ... contenu coupé de l'étape 2 (commence par `const rotatingSet = ...`) ...
}
```

Ajouter `const warnings: string[] = [];` en première ligne du corps collé (cette déclaration existait déjà en L105 dans l'ancienne fonction, avant le point de coupe — il faut la reporter ici).

4. Dans le contenu collé, faire ces 3 ajustements mécaniques :

   a. L'appel `buildOngoingSessionsFromPlan({ ... }, input.startTime, 0, [...playerSet])` (ligne ~317-327 de l'ancien fichier) devient :

   ```typescript
       const sessions = buildOngoingSessionsFromPlan(
         {
           dryRun: true,
           proposedBookings: proposedWithMeta,
           warnings: [],
           meta: { ...emptyMeta, roundsPlanned: totalRounds, rotatingPlayerIds: [...rotatingPlayerIds] },
         },
         input.startTime,
         0,
         [...playerSet],
         input.playSlotsDefaults ?? DEFAULT_PLAY_SLOTS,
         input.playerPlaySlots ?? new Map(),
       );
   ```

   b. Dans l'appel `extendSessionForLateJoiners({ session, lateJoinerIds: remainingRotators, ... })`, retirer la ligne `slotsPerPlayer: input.slotsPerPlayer,` (le champ n'existe plus dans `ExtendSessionOptions`, Task 5).

   c. Juste après cet appel, `remainingRotators = remainingRotators.filter((id) => !session.players.includes(id));` devient `remainingRotators = remainingRotators.filter((id) => !session.members.includes(id));` (`OngoingSession.players` renommé `members`, Task 5).

5. Remplacer le corps désormais vide de `computeGroupBookingPlan` (tout ce qui suivait `if (sortedTimes.length === 0) { ... }`, maintenant supprimé par la coupe de l'étape 2) par :

```typescript
  if (pairs.length <= courtsNeeded) {
    return computeCommonCasePlan(input, courtsNeeded, byTime, sortedTimes, emptyMeta);
  }
  return computeQueueingCasePlan(
    input,
    pairs,
    rotatingPlayerIds,
    remainingSubstituteIds,
    playerSet,
    courtsNeeded,
    byTime,
    sortedTimes,
    emptyMeta,
  );
}
```

`computeGroupBookingPlan` se termine donc juste après le `if (sortedTimes.length === 0) { ... }` (L157-160, inchangé) suivi de ce dispatch — la fonction ne calcule plus elle-même de warning "Effectif impair" ni de `rotatingSet`/`substituteQueue` (déplacés dans `computeQueueingCasePlan`), seulement `pairs`/`rotatingPlayerIds`/`remainingSubstituteIds`/`playerSet`/`courtsNeeded`/`byTime`/`sortedTimes`/`emptyMeta`, qui restent nécessaires pour choisir la branche et sont passés aux deux fonctions.

6. Ajouter, juste avant `computeQueueingCasePlan`, la nouvelle fonction pour le cas courant :

```typescript
/**
 * Cas courant : le nombre de groupes (paires, + le joueur en rotation le cas échéant fusionné
 * dans le 1er groupe, cf. groups.ts) tient dans `courtsNeeded` — aucune file d'attente entre
 * groupes n'est nécessaire, chaque groupe reçoit sa propre timeline continue
 * (scheduleGroupTimeline.ts) au lieu de couches synchronisées.
 */
function computeCommonCasePlan(
  input: ComputeGroupBookingPlanInput,
  courtsNeeded: number,
  byTime: Map<string, AvailableSlot[]>,
  sortedTimes: string[],
  emptyMeta: GroupBookingPlan["meta"],
): GroupBookingPlan {
  const { groups, remainingSubstituteIds, warnings: groupWarnings } = buildGroupsForBooking(
    input.expectedPlayerIds,
    input.substitutePlayerIds,
    input.playSlotsDefaults ?? DEFAULT_PLAY_SLOTS,
    input.playerPlaySlots ?? new Map(),
  );

  const warnings = [...groupWarnings];
  const claimedThisCall = new Set<string>();
  const substituteQueue = [...remainingSubstituteIds];
  const proposedBookings: GroupBookingPlan["proposedBookings"] = [];

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
      existingDailyCounts: input.existingDailyCounts ?? {},
      maxDailyReservationsPerPlayer: input.maxDailyReservationsPerPlayer,
      apiUserId: input.apiUserId,
      warnings,
    });
    proposedBookings.push(...bookings);
  }

  return {
    dryRun: true,
    proposedBookings,
    warnings,
    meta: { ...emptyMeta, courtsNeeded, roundsPlanned: proposedBookings.length },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && npx vitest run src/planning/groupBookingPlan.test.ts`
Expected: PASS pour tous les tests, y compris les 2 nouveaux et le scénario "8 joueurs, plafond 3 courts, 2 couches" (cas file d'attente, doit rester inchangé).

- [ ] **Step 5: Typecheck complet**

Run: `./node_modules/.bin/tsc -p apps/worker/tsconfig.build.json --noEmit`
Expected: aucune erreur.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/planning/groupBookingPlan.ts apps/worker/src/planning/groupBookingPlan.test.ts
git commit -m "feat(planning): computeGroupBookingPlan — dispatcher groupes (cas courant) / couches (file d'attente)"
```

---

### Task 8: Scénarios de régression — rejouer et ajuster les fixtures

**Files:**
- Modify: `apps/worker/src/planning/__fixtures__/scenarios/*.json` (si besoin)
- Verify: `apps/worker/src/planning/scenarios.regression.test.ts`

- [ ] **Step 1: Lancer les scénarios de régression**

Run: `cd apps/worker && npx vitest run src/planning/scenarios.regression.test.ts`

- [ ] **Step 2: Pour chaque échec, examiner le diff**

Si `expect(groups).toEqual(fixture.expectedPlan)` échoue :
- Si seul le **texte d'un warning** diffère (nouveau libellé de `sessionExtension.ts`/`groups.ts`) : ouvrir le fichier fixture JSON correspondant dans `__fixtures__/scenarios/`, mettre à jour la chaîne de warning attendue pour correspondre exactement au nouveau texte produit (visible dans le diff Vitest).
- Si les **réservations elles-mêmes** diffèrent (joueurs, courts, horaires) : ne pas modifier la fixture sans comprendre pourquoi — comparer avec le comportement attendu du nouveau modèle (groupes/rounds). Un changement de réservations est acceptable seulement s'il correspond à une amélioration attendue du nouveau modèle (ex. moins de rounds nécessaires) — documenter le changement dans le commit.

- [ ] **Step 3: Relancer jusqu'à stabilisation**

Run: `cd apps/worker && npx vitest run src/planning/scenarios.regression.test.ts`
Expected: PASS

- [ ] **Step 4: Suite complète du workspace worker**

Run: `cd apps/worker && npx vitest run`
Expected: tous les tests PASS.

Run: `./node_modules/.bin/tsc -p apps/worker/tsconfig.build.json --noEmit`
Expected: aucune erreur.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/planning/__fixtures__/scenarios/
git commit -m "test(planning): ajuste les fixtures de régression au nouveau modèle de groupes"
```

(Si aucun fichier fixture n'a changé, ce commit est vide — passer directement à la Task 9.)

---

### Task 9: Documentation — `docs/spec/regles-fonctionnelles.md`

**Files:**
- Modify: `docs/spec/regles-fonctionnelles.md`

- [ ] **Step 1: Repérer la section §4 (Plan de réservation)**

Run: `grep -n "^## 4\." docs/spec/regles-fonctionnelles.md`

- [ ] **Step 2: Ajouter une entrée décrivant le nouveau modèle**

Dans la section §4, ajouter (après la description existante de l'algorithme de pairage/couches) :

```markdown
- **Planification par groupes et rounds (2026-08-23)** : le moteur local (`apps/worker/src/planning/groupBookingPlan.ts`, `groups.ts`) calcule un **groupe** de 2 joueurs (paire classique) ou 3 (paire + joueur en rotation si effectif impair — fusionné dans le 1er groupe, jamais laissé de côté) par court. Le nombre de rounds de 45 min réservés par groupe est calculé **globalement** à partir des préférences individuelles de temps de jeu (`/players`, `resolvePlayerPlaySlots`) — pas de suivi de qui joue à quel round précis : une fois le court réservé pour le nombre de rounds nécessaire, les joueurs s'arrangent physiquement entre eux pour tourner. Le nommage TeamR (2 noms/réservation) suit un cycle round-robin fixe pour un groupe de 3. **Cas courant** (nombre de groupes ≤ courts simultanés autorisés, `maxCourtsPerSlot`) : chaque groupe est planifié indépendamment sur sa propre timeline continue, sans créneau vide artificiel. **Cas file d'attente** (plus de groupes que de courts simultanés) : logique par couches conservée (limitation connue, non optimale en nombre total de rounds — hors périmètre de la refonte 2026-08-23).
```

- [ ] **Step 3: Mettre à jour l'historique des décisions**

Repérer la dernière ligne du tableau "Historique des décisions notables" (`grep -n "^## Historique" docs/spec/regles-fonctionnelles.md` puis lire les dernières lignes du fichier) et ajouter :

```markdown
| 2026-08-23 | Planification par groupes (2-3 joueurs) et rounds globaux, remplace couches rigides + intégration après coup du joueur en rotation (`groups.ts`, `scheduleGroupTimeline.ts`) | Le joueur en rotation était intégré après que les paires classiques avaient déjà fini leurs couches, forçant des rounds supplémentaires évitables (calcul exact : régression rapportée 2026-08-23, 7 joueurs/3 courts, 4 rounds au lieu de 3 nécessaires) ; au passage, les préférences individuelles de temps de jeu (`/players`) s'appliquent désormais aussi aux paires classiques (elles ne l'étaient qu'au joueur en rotation) |
```

- [ ] **Step 4: Commit**

```bash
git add docs/spec/regles-fonctionnelles.md
git commit -m "docs(spec): §4 — planification par groupes et rounds globaux"
```

---

### Task 10: Vérification finale

**Files:** aucun (vérification uniquement)

- [ ] **Step 1: Typecheck sur tous les workspaces**

Run: `npm run typecheck`
Expected: aucune erreur (worker, ui, db).

- [ ] **Step 2: Suite de tests complète du worker**

Run: `cd apps/worker && npx vitest run`
Expected: tous les tests PASS.

- [ ] **Step 3: Suite de tests des autres workspaces (si présents)**

Run: `npm test --workspaces --if-present`
Expected: tous les tests PASS.

- [ ] **Step 4: Relire le diff complet de la branche**

Run: `git log --oneline docs/superpowers/plans/2026-08-23-group-round-scheduling.md` puis `git diff <premier commit de ce plan>~1..HEAD --stat`
Vérifier qu'aucun fichier hors périmètre n'a été modifié par inadvertance.

- [ ] **Step 5: Résumer au responsable du repo**

Pas de commit pour cette étape — signaler la fin de l'implémentation, pointer vers la spec (`docs/superpowers/specs/2026-08-23-group-round-scheduling-design.md`) et ce plan, et rappeler la limitation connue non traitée (cas file d'attente, plus de groupes que de courts simultanés).
