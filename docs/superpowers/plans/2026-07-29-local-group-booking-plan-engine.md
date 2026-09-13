# Moteur de calcul du plan de réservation local à squash-assistant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rapatrier dans squash-assistant le calcul du plan de réservation (appariement des joueurs, choix de court, rotation, gestion du quota du titulaire de la clé API) aujourd'hui entièrement délégué à `plan_group_bookings` (MCP resa-squash), pour le rendre testable localement.

**Architecture:** Un nouveau module pur (`apps/worker/src/planning/`) porte fidèlement l'algorithme actuel de `resa-squash` (`app/services/group-booking-plan.ts`), sans aucun appel réseau. `bookSlots.ts` appelle `list_availability` (une fois par job, tous courts/toute la plage horaire) et `list_my_reservations_on_date` (quota du titulaire), puis invoque ce module localement par heure candidate, en partageant les `sessionId` déjà retenus entre heures candidates successives — ce qui rend le double-booking de court structurellement impossible (remplace le correctif de détection a posteriori). `resa-squash` (`plan_group_bookings`) n'est plus appelé par squash-assistant ; il reste inchangé et disponible pour OpenClaw.

**Tech Stack:** TypeScript, Vitest, `@modelcontextprotocol/sdk` (client MCP existant), LangGraph.js (inchangé).

## Global Constraints

- Port fidèle d'abord (aucun changement de règle métier par rapport au comportement actuel) — décision utilisateur.
- Bascule directe une fois les tests verts : pas de flag de configuration, pas de double-chemin temporaire.
- Aucun changement du contrat MCP `resa-squash` — seuls `list_availability`, `list_my_reservations_on_date`, `reserve_slot`, `cancel_reservation` sont utilisés, tous déjà exposés aujourd'hui.
- Le type `GroupBookingPlan` (`apps/worker/src/mcp/resaSquash.ts`) ne change pas — tout le code en aval (`capacityPlanning.ts`, `announce.ts`, `state.ts`, l'UI) doit continuer de fonctionner sans modification de ce type.
- Constantes club en dur (comme aujourd'hui côté resa-squash) : `SQUASH_SLOT_MINUTES = 45`, `SQUASH_COURT_COUNT = 4`, `MIN_PLAYERS_PER_COURT_GROUP = 2`, `MAX_PLAYERS_PER_COURT_GROUP = 3` — pas de champ de config squash-assistant pour l'instant (question ouverte #1 de la spec, tranchée : garder en dur pour ce projet, réévaluable plus tard si un 2e club apparaît).
- Fichiers de test : `describe`/`it`/`expect` de Vitest, style AAA, noms de test descriptifs en français — suivre exactement les conventions déjà en place dans `apps/worker/src/graph/capacityPlanning.test.ts` et `apps/worker/src/graph/buildBookingParams.test.ts`.
- Toute commande shell doit être lancée depuis la racine du repo (`/Users/vinz/workspace/squash-assistant`), typecheck via `./node_modules/.bin/tsc -p apps/worker/tsconfig.build.json --noEmit`, tests via `cd apps/worker && npx vitest run <fichier>`.

---

## File Structure

Nouveau dossier `apps/worker/src/planning/` — le moteur de calcul pur, sans dépendance à `BookingRule` ni au client MCP :

| Fichier | Responsabilité |
|---|---|
| `constants.ts` | Constantes club (créneaux, courts, plafonds bas/haut par court) |
| `pairing.ts` | Appariement des joueurs confirmés en paires ; rotation si effectif impair sans prête-nom |
| `courtAssignment.ts` | Attribution d'un court à chaque paire d'un round, avec continuité de court sur créneaux successifs |
| `teamrTime.ts` | Helpers de temps TeamR (format `18H45`) — réexporte `parseTeamrTime` existant, ajoute la conversion inverse et le calcul de `startDate` ISO |
| `groupBookingPlan.ts` | Fonction principale `computeGroupBookingPlan` — boucle de couches, orchestration des 3 fichiers ci-dessus, gestion du quota titulaire |

Modifiés :

| Fichier | Changement |
|---|---|
| `apps/worker/src/mcp/resaSquash.ts` | `AvailabilitySlot` corrigé pour refléter le vrai payload `list_availability` ; `planGroupBookings`/`PlanGroupBookingsParams`/`planGroupSession` retirés (plus utilisés) |
| `apps/worker/src/graph/buildBookingParams.ts` → renommé `apps/worker/src/graph/buildGroupBookingPlanParams.ts` | Construit les paramètres du moteur local au lieu des paramètres MCP |
| `apps/worker/src/graph/nodes/bookSlots.ts` | Appelle `list_availability` + `list_my_reservations_on_date` + le moteur local ; supprime le mécanisme de détection de conflit (devenu inutile) |
| `apps/worker/src/graph/capacityPlanning.ts` | Retire `courtIntervalsFromPlan`/`conflictingSessionIds`/`busyCourtsDuring` |
| `apps/worker/src/graph/state.ts` | Retire `conflictingSessionIds` de `BookingPlanGroup` |
| `apps/worker/src/graph/nodes/announce.ts` | Retire la gestion de `conflictingSessionIds` |
| `apps/ui/src/lib/worker.ts`, `apps/ui/src/app/rules/[id]/jobs/[jobId]/Pipeline.tsx` | Retire `conflictingSessionIds` |
| `apps/worker/src/scripts/test-mcp-connections.ts` | Remplace la démo `plan_group_bookings` par `list_availability` |
| `docs/spec/regles-fonctionnelles.md` §4 | Mis à jour pour refléter la nouvelle architecture |
| `docs/adr/` | Nouvel ADR-018 |

---

### Task 1: Corriger le type client `AvailabilitySlot` et ajouter le wrapper de quota

**Files:**
- Modify: `apps/worker/src/mcp/resaSquash.ts`
- Test: `apps/worker/src/mcp/resaSquash.test.ts` (nouveau)

**Interfaces:**
- Produces: `AvailabilitySlot { sessionId: string; court: number; beginTime: string; endTime: string; date: string; available: boolean; occupiedPlayerIds: string[] }`, `listAvailability(client, dateFrom, dateTo, courts?): Promise<{ availability: Array<{ date: string; slots: AvailabilitySlot[] }> }>`, `listMyReservationsOnDate(client, onDate, timeZone?): Promise<{ userId: string; reservations: Array<{ sessionId: string; userId: string; partnerId: string }> }>` (signature déjà existante, seul le retour est élargi avec `userId` au niveau racine).

Le payload réel de `list_availability` (vérifié dans le code source de `resa-squash`, `app/api/mcp/route.ts` + `app/types/reservation.ts`) est `{ dateFrom, dateTo, availability: Array<{ date, slots: Reservation[] }> }` où chaque `Reservation` = `{ id, court, time, endTime, date, participants, available, users: Array<{ id, firstName, lastName, email, yes }> }`. Le type `AvailabilitySlot` actuel (`{ court, beginTime, endTime }`) ne correspond pas à ce payload — jamais exercé jusqu'ici (`list_availability` n'était pas appelé par squash-assistant).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/mcp/resaSquash.test.ts
import { describe, expect, it, vi } from "vitest";

const callToolMock = vi.fn();
vi.mock("./client.js", () => ({
  callTool: (...args: unknown[]) => callToolMock(...args),
}));

const { listAvailability, listMyReservationsOnDate } = await import("./resaSquash.js");

describe("listAvailability", () => {
  it("transmet dateFrom/dateTo/courts et renvoie le payload tel quel", async () => {
    const payload = {
      dateFrom: "2026-08-04",
      dateTo: "2026-08-04",
      availability: [
        {
          date: "2026-08-04",
          slots: [
            {
              id: "sess-1",
              court: 4,
              time: "18H45",
              endTime: "19H30",
              date: "2026-08-04",
              participants: 0,
              available: true,
              users: [],
            },
          ],
        },
      ],
    };
    callToolMock.mockResolvedValueOnce(payload);

    const result = await listAvailability({} as never, "2026-08-04", "2026-08-04", [4]);

    expect(callToolMock).toHaveBeenCalledWith({}, "list_availability", {
      dateFrom: "2026-08-04",
      dateTo: "2026-08-04",
      courts: [4],
    });
    expect(result).toEqual(payload);
  });
});

describe("listMyReservationsOnDate", () => {
  it("transmet onDate/timeZone et renvoie userId + reservations", async () => {
    const payload = { userId: "api-user-1", onDate: "2026-08-04", timeZone: "Europe/Paris", reservations: [] };
    callToolMock.mockResolvedValueOnce(payload);

    const result = await listMyReservationsOnDate({} as never, "2026-08-04", "Europe/Paris");

    expect(callToolMock).toHaveBeenCalledWith({}, "list_my_reservations_on_date", {
      onDate: "2026-08-04",
      timeZone: "Europe/Paris",
    });
    expect(result.userId).toBe("api-user-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && npx vitest run src/mcp/resaSquash.test.ts`
Expected: FAIL — `listAvailability`/`listMyReservationsOnDate` payload shape mismatch, ou `AvailabilitySlot` non conforme au typage attendu par le test (erreur TypeScript sur `result.availability[0].slots[0].id`/`time` inexistants sur le type actuel).

- [ ] **Step 3: Corriger `AvailabilitySlot` et les types de retour**

Dans `apps/worker/src/mcp/resaSquash.ts`, remplacer :

```typescript
export interface AvailabilitySlot {
  court: number;
  beginTime: string;
  endTime: string;
}
```

par :

```typescript
export interface AvailabilityUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  yes: boolean;
}

/** Reflète le payload réel de list_availability côté resa-squash (app/types/reservation.ts) — pas de transformation de champs. */
export interface AvailabilitySlot {
  id: string;
  court: number;
  time: string;
  endTime: string;
  date: string;
  participants: number;
  available: boolean;
  users: AvailabilityUser[];
}
```

Et le retour de `listMyReservationsOnDate` :

```typescript
export function listMyReservationsOnDate(
  client: Client,
  onDate: string,
  timeZone = "Europe/Paris",
): Promise<{ userId: string; onDate: string; timeZone: string; reservations: Reservation[] }> {
  return callTool(client, "list_my_reservations_on_date", { onDate, timeZone });
}
```

(Le corps de la fonction ne change pas, seul le type de retour déclaré est élargi.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && npx vitest run src/mcp/resaSquash.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `./node_modules/.bin/tsc -p apps/worker/tsconfig.build.json --noEmit`
Expected: aucune erreur (si `AvailabilitySlot`/`listAvailability` sont utilisés ailleurs avec les anciens noms de champs, corriger ces appels — à ce stade, aucun appelant n'existe encore).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/mcp/resaSquash.ts apps/worker/src/mcp/resaSquash.test.ts
git commit -m "fix(mcp): corrige AvailabilitySlot pour refléter le vrai payload list_availability"
```

---

### Task 2: Constantes et calcul du nombre de courts nécessaires

**Files:**
- Create: `apps/worker/src/planning/constants.ts`
- Create: `apps/worker/src/planning/courtsNeeded.ts`
- Test: `apps/worker/src/planning/courtsNeeded.test.ts`

**Interfaces:**
- Produces: `SQUASH_SLOT_MINUTES`, `SQUASH_COURT_COUNT`, `MIN_PLAYERS_PER_COURT_GROUP`, `MAX_PLAYERS_PER_COURT_GROUP` (constants.ts) ; `courtsNeededForPlayers(playerCount: number, preferMin?: boolean): number` (courtsNeeded.ts)

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/planning/courtsNeeded.test.ts
import { describe, expect, it } from "vitest";
import { courtsNeededForPlayers } from "./courtsNeeded.js";

describe("courtsNeededForPlayers", () => {
  it("0 joueur → 0 court", () => {
    expect(courtsNeededForPlayers(0)).toBe(0);
  });

  it("remplissage max (défaut, 3 joueurs/court) : 4 joueurs → 2 courts", () => {
    expect(courtsNeededForPlayers(4)).toBe(2);
  });

  it("remplissage max : 3 joueurs → 1 court", () => {
    expect(courtsNeededForPlayers(3)).toBe(1);
  });

  it("remplissage min (2 joueurs/court) : 4 joueurs → 2 courts", () => {
    expect(courtsNeededForPlayers(4, true)).toBe(2);
  });

  it("remplissage min : 3 joueurs → 2 courts (pas 1, plafond min = 2)", () => {
    expect(courtsNeededForPlayers(3, true)).toBe(2);
  });

  it("remplissage min : 6 joueurs → 3 courts", () => {
    expect(courtsNeededForPlayers(6, true)).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && npx vitest run src/planning/courtsNeeded.test.ts`
Expected: FAIL — le module `./courtsNeeded.js` n'existe pas.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/worker/src/planning/constants.ts
/** Durée d'un créneau squash (TeamR / club). */
export const SQUASH_SLOT_MINUTES = 45;

/** Nombre de courts squash gérés par la logique métier locale. */
export const SQUASH_COURT_COUNT = 4;

/** Par réservation TeamR : exactement 2 joueurs. */
export const PLAYERS_PER_BOOKING = 2;

/** Répartition groupe : entre 2 et 3 joueurs « comptés » par court pour estimer le nombre de courts. */
export const MIN_PLAYERS_PER_COURT_GROUP = 2;
export const MAX_PLAYERS_PER_COURT_GROUP = 3;
```

```typescript
// apps/worker/src/planning/courtsNeeded.ts
import { MAX_PLAYERS_PER_COURT_GROUP, MIN_PLAYERS_PER_COURT_GROUP } from "./constants.js";

/**
 * Nombre de courts à réserver pour couvrir N joueurs.
 * `preferMin` (défaut false) : true = remplir chaque court au minimum
 * (moins de joueurs/court, plus de courts utilisés simultanément).
 */
export function courtsNeededForPlayers(playerCount: number, preferMin = false): number {
  if (playerCount <= 0) return 0;
  const divisor = preferMin ? MIN_PLAYERS_PER_COURT_GROUP : MAX_PLAYERS_PER_COURT_GROUP;
  if (playerCount <= divisor) return 1;
  return Math.ceil(playerCount / divisor);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && npx vitest run src/planning/courtsNeeded.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/planning/constants.ts apps/worker/src/planning/courtsNeeded.ts apps/worker/src/planning/courtsNeeded.test.ts
git commit -m "feat(planning): port courtsNeededForPlayers et constantes club"
```

---

### Task 3: Appariement des joueurs (`buildPairsForGroupBooking`)

**Files:**
- Create: `apps/worker/src/planning/pairing.ts`
- Test: `apps/worker/src/planning/pairing.test.ts`

**Interfaces:**
- Consumes: rien (module autonome)
- Produces: `GroupBookingPair { userId: string; partnerId: string }`, `BuildPairsResult { pairs: GroupBookingPair[]; rotatingPlayerIds: string[]; remainingSubstituteIds: string[] }`, `buildPairsForGroupBooking(expected: string[], substitutes: string[]): BuildPairsResult` (lève `Error("NEED_AT_LEAST_TWO_PLAYERS")` si moins de 2 joueurs uniques)

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/planning/pairing.test.ts
import { describe, expect, it } from "vitest";
import { buildPairsForGroupBooking } from "./pairing.js";

describe("buildPairsForGroupBooking", () => {
  it("effectif pair : forme des paires successives, pas de rotation ni prête-nom consommé", () => {
    const result = buildPairsForGroupBooking(["a", "b", "c", "d"], ["sub-1"]);
    expect(result.pairs).toEqual([
      { userId: "a", partnerId: "b" },
      { userId: "c", partnerId: "d" },
    ]);
    expect(result.rotatingPlayerIds).toEqual([]);
    expect(result.remainingSubstituteIds).toEqual(["sub-1"]);
  });

  it("effectif impair avec prête-nom dispo : le dernier joueur est apparié au 1er prête-nom", () => {
    const result = buildPairsForGroupBooking(["a", "b", "c"], ["sub-1", "sub-2"]);
    expect(result.pairs).toEqual([
      { userId: "a", partnerId: "b" },
      { userId: "c", partnerId: "sub-1" },
    ]);
    expect(result.rotatingPlayerIds).toEqual([]);
    expect(result.remainingSubstituteIds).toEqual(["sub-2"]);
  });

  it("effectif impair sans prête-nom : le dernier joueur unique tourne (rotatingPlayerIds), pas de paire pour lui", () => {
    const result = buildPairsForGroupBooking(["a", "b", "c"], []);
    expect(result.pairs).toEqual([{ userId: "a", partnerId: "b" }]);
    expect(result.rotatingPlayerIds).toEqual(["c"]);
    expect(result.remainingSubstituteIds).toEqual([]);
  });

  it("dédoublonne les ids en conservant l'ordre d'apparition", () => {
    const result = buildPairsForGroupBooking(["a", "b", "a", "c"], []);
    expect(result.pairs).toEqual([{ userId: "a", partnerId: "b" }]);
    expect(result.rotatingPlayerIds).toEqual(["c"]);
  });

  it("lève une erreur si moins de 2 joueurs uniques", () => {
    expect(() => buildPairsForGroupBooking(["a"], [])).toThrowError("NEED_AT_LEAST_TWO_PLAYERS");
    expect(() => buildPairsForGroupBooking(["a", "a"], [])).toThrowError("NEED_AT_LEAST_TWO_PLAYERS");
  });

  it("dédoublonne aussi les prête-noms", () => {
    const result = buildPairsForGroupBooking(["a", "b", "c"], ["sub-1", "sub-1"]);
    expect(result.pairs).toEqual([
      { userId: "a", partnerId: "b" },
      { userId: "c", partnerId: "sub-1" },
    ]);
    expect(result.remainingSubstituteIds).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && npx vitest run src/planning/pairing.test.ts`
Expected: FAIL — module inexistant.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/worker/src/planning/pairing.ts
export interface GroupBookingPair {
  userId: string;
  partnerId: string;
}

export interface BuildPairsResult {
  pairs: GroupBookingPair[];
  /** Sans prête-nom et effectif impair : dernier joueur (ordre conservé, dédoublonné) sans paire TeamR. */
  rotatingPlayerIds: string[];
  /** Prête-noms non consommés par l'appariement d'effectif impair — réutilisables pour le quota titulaire. */
  remainingSubstituteIds: string[];
}

/**
 * Constitue les paires pour reserve_slot (2 noms / résa).
 * - Effectif pair : tout le monde est apparié.
 * - Effectif impair + prête-noms disponibles : le dernier joueur est apparié au 1er prête-nom.
 * - Effectif impair sans prête-nom : le dernier id unique tourne (rotatingPlayerIds), hors TeamR pour ce plan.
 * Port fidèle de resa-squash (group-booking-plan.ts, buildPairsForGroupBooking).
 */
export function buildPairsForGroupBooking(expected: string[], substitutes: string[]): BuildPairsResult {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of expected.map(String).filter(Boolean)) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }

  if (ordered.length < 2) {
    throw new Error("NEED_AT_LEAST_TWO_PLAYERS");
  }

  const subsQueue = [...new Set(substitutes.map(String).filter(Boolean))];
  const rotatingPlayerIds: string[] = [];
  const work = [...ordered];

  if (work.length % 2 === 1) {
    if (subsQueue.length > 0) {
      const sub = subsQueue.shift()!;
      work.push(sub);
    } else {
      const rotator = work.pop();
      if (rotator !== undefined) {
        rotatingPlayerIds.push(rotator);
      }
    }
  }

  const pairs: GroupBookingPair[] = [];
  const q = [...work];
  while (q.length >= 2) {
    pairs.push({ userId: q.shift()!, partnerId: q.shift()! });
  }

  return { pairs, rotatingPlayerIds, remainingSubstituteIds: subsQueue };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && npx vitest run src/planning/pairing.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/planning/pairing.ts apps/worker/src/planning/pairing.test.ts
git commit -m "feat(planning): port buildPairsForGroupBooking (appariement + rotation)"
```

---

### Task 4: Helpers de temps TeamR

**Files:**
- Create: `apps/worker/src/planning/teamrTime.ts`
- Test: `apps/worker/src/planning/teamrTime.test.ts`

**Interfaces:**
- Consumes: `parseTeamrTime` déjà exporté par `apps/worker/src/graph/capacityPlanning.ts` (ne pas dupliquer)
- Produces: `formatTeamrTimeFromMinutes(minsTotal: number): string`, `slotStartDateIsoHeuristicParis(ymd: string, timeLabel: string): string | null`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/planning/teamrTime.test.ts
import { describe, expect, it } from "vitest";
import { formatTeamrTimeFromMinutes, slotStartDateIsoHeuristicParis } from "./teamrTime.js";

describe("formatTeamrTimeFromMinutes", () => {
  it("convertit des minutes en libellé TeamR", () => {
    expect(formatTeamrTimeFromMinutes(18 * 60 + 45)).toBe("18H45");
    expect(formatTeamrTimeFromMinutes(9 * 60)).toBe("9H00");
  });
});

describe("slotStartDateIsoHeuristicParis", () => {
  it("applique +02:00 en été (avril à octobre)", () => {
    expect(slotStartDateIsoHeuristicParis("2026-08-04", "18H45")).toBe("2026-08-04T18:45:00+02:00");
  });

  it("applique +01:00 en hiver (novembre à mars)", () => {
    expect(slotStartDateIsoHeuristicParis("2026-01-15", "10H30")).toBe("2026-01-15T10:30:00+01:00");
  });

  it("retourne null sur un horaire invalide", () => {
    expect(slotStartDateIsoHeuristicParis("2026-08-04", "invalide")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && npx vitest run src/planning/teamrTime.test.ts`
Expected: FAIL — module inexistant.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/worker/src/planning/teamrTime.ts
import { parseTeamrTime } from "../graph/capacityPlanning.js";

export { parseTeamrTime };

/** Minutes depuis minuit → libellé TeamR (ex. 1125 → "18H45"). */
export function formatTeamrTimeFromMinutes(minsTotal: number): string {
  const h = Math.floor(minsTotal / 60);
  const m = minsTotal % 60;
  return `${h}H${String(m).padStart(2, "0")}`;
}

/**
 * Construit une date/heure ISO pour reserve_slot à partir du jour et du libellé TeamR (ex. 18H45).
 * Heuristique fuseau Europe/Paris : +02 avril-octobre, +01 sinon (DST imparfait mars/novembre).
 * Port fidèle de resa-squash (group-booking-rules.ts, slotStartDateIsoHeuristicParis).
 */
export function slotStartDateIsoHeuristicParis(ymd: string, timeLabel: string): string | null {
  const mins = parseTeamrTime(timeLabel);
  if (mins == null) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const month = Number(ymd.slice(5, 7));
  const offset = month >= 4 && month <= 10 ? "+02:00" : "+01:00";
  return `${ymd}T${pad(h)}:${pad(m)}:00${offset}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && npx vitest run src/planning/teamrTime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/planning/teamrTime.ts apps/worker/src/planning/teamrTime.test.ts
git commit -m "feat(planning): helpers de temps TeamR (format inverse + startDate ISO)"
```

---

### Task 5: Attribution de court avec continuité sur créneaux successifs

**Files:**
- Create: `apps/worker/src/planning/courtAssignment.ts`
- Test: `apps/worker/src/planning/courtAssignment.test.ts`

**Interfaces:**
- Consumes: `GroupBookingPair` (Task 3)
- Produces: `AvailableSlot { sessionId: string; court: number; beginTime: string; endTime: string }`, `ProposedSlot { userId: string; partnerId: string; court: number; slotTime: string; slotEndTime: string }`, `resolveCourtAssignments(availableAtTime: AvailableSlot[], pairsThisRound: GroupBookingPair[], proposedSoFar: ProposedSlot[], courtPriority: number[], nextSlotCourts: Set<number> | null): Array<{ pair: GroupBookingPair; slot: AvailableSlot }> | null`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/planning/courtAssignment.test.ts
import { describe, expect, it } from "vitest";
import { resolveCourtAssignments, type AvailableSlot, type ProposedSlot } from "./courtAssignment.js";
import type { GroupBookingPair } from "./pairing.js";

function slot(court: number, beginTime = "18H45", endTime = "19H30"): AvailableSlot {
  return { sessionId: `s-${court}-${beginTime}`, court, beginTime, endTime };
}

describe("resolveCourtAssignments", () => {
  it("retourne null si moins de courts disponibles que de paires", () => {
    const result = resolveCourtAssignments(
      [slot(4)],
      [{ userId: "a", partnerId: "b" }, { userId: "c", partnerId: "d" }],
      [],
      [4, 3, 2, 1],
      null,
    );
    expect(result).toBeNull();
  });

  it("respecte courtPriority quand aucune continuité n'est en jeu", () => {
    const result = resolveCourtAssignments(
      [slot(1), slot(3), slot(4)],
      [{ userId: "a", partnerId: "b" }],
      [],
      [4, 3, 2, 1],
      null,
    );
    expect(result).toEqual([{ pair: { userId: "a", partnerId: "b" }, slot: slot(4) }]);
  });

  it("garde le court déjà utilisé par la même paire dans une couche précédente (continuité)", () => {
    const proposedSoFar: ProposedSlot[] = [
      { userId: "a", partnerId: "b", court: 3, slotTime: "18H45", slotEndTime: "19H30" },
    ];
    const result = resolveCourtAssignments(
      [slot(3, "19H30", "20H15"), slot(4, "19H30", "20H15")],
      [{ userId: "a", partnerId: "b" }],
      proposedSoFar,
      [4, 3, 2, 1], // le court 4 est mieux classé, mais la paire doit rester sur le 3 (continuité)
      null,
    );
    expect(result).toEqual([{ pair: { userId: "a", partnerId: "b" }, slot: slot(3, "19H30", "20H15") }]);
  });

  it("préfère un court disponible sur les 2 créneaux successifs à un court mieux classé mais dispo sur un seul", () => {
    // Exemple exact de la doc : courtPriority=[4,3,2,1], le 4 n'est libre que sur ce créneau,
    // le 3 est libre sur ce créneau ET le suivant → le plan retient le 3.
    const result = resolveCourtAssignments(
      [slot(3), slot(4)],
      [{ userId: "a", partnerId: "b" }],
      [],
      [4, 3, 2, 1],
      new Set([3]), // seul le court 3 est aussi dispo au créneau suivant
    );
    expect(result).toEqual([{ pair: { userId: "a", partnerId: "b" }, slot: slot(3) }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && npx vitest run src/planning/courtAssignment.test.ts`
Expected: FAIL — module inexistant.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/worker/src/planning/courtAssignment.ts
import type { GroupBookingPair } from "./pairing.js";

export interface AvailableSlot {
  sessionId: string;
  court: number;
  beginTime: string;
  endTime: string;
}

export interface ProposedSlot {
  userId: string;
  partnerId: string;
  court: number;
  slotTime: string;
  slotEndTime: string;
}

function orderByCourtPriority(slots: AvailableSlot[], courtPriority: number[]): AvailableSlot[] {
  if (!courtPriority || courtPriority.length === 0) return slots;
  const rank = new Map(courtPriority.map((c, i) => [c, i]));
  return [...slots].sort((a, b) => {
    const ra = rank.get(a.court) ?? courtPriority.length + a.court;
    const rb = rank.get(b.court) ?? courtPriority.length + b.court;
    return ra - rb;
  });
}

/** Court utilisé par cette paire (mêmes 2 joueurs, ordre indifférent) dans une couche déjà planifiée. */
function previousCourtForPair(proposedSoFar: ProposedSlot[], userId: string, partnerId: string): number | null {
  for (let i = proposedSoFar.length - 1; i >= 0; i -= 1) {
    const b = proposedSoFar[i]!;
    const samePair =
      (b.userId === userId && b.partnerId === partnerId) || (b.userId === partnerId && b.partnerId === userId);
    if (samePair) return b.court;
  }
  return null;
}

/**
 * Assigne un court à chaque paire du round, en priorisant la continuité de court sur 2 créneaux
 * successifs d'une même résa avant courtPriority :
 * 1. Une paire déjà réservée sur un court dans une couche précédente garde ce court s'il est encore dispo.
 * 2. Pour les paires restantes, si `nextSlotCourts` est fourni, les courts dispo aussi sur le
 *    prochain créneau passent avant ceux dispo seulement maintenant.
 * 3. Le reste suit courtPriority.
 * Retourne null si le nombre de courts distincts disponibles est insuffisant.
 * Port fidèle de resa-squash (group-booking-plan.ts, resolveCourtAssignments).
 */
export function resolveCourtAssignments(
  availableAtTime: AvailableSlot[],
  pairsThisRound: GroupBookingPair[],
  proposedSoFar: ProposedSlot[],
  courtPriority: number[],
  nextSlotCourts: Set<number> | null,
): Array<{ pair: GroupBookingPair; slot: AvailableSlot }> | null {
  if (availableAtTime.length < pairsThisRound.length) return null;

  const byCourt = new Map<number, AvailableSlot>();
  for (const s of availableAtTime) {
    byCourt.set(s.court, s);
  }
  if (byCourt.size < pairsThisRound.length) return null;

  const remainingCourts = new Set(byCourt.keys());
  const assignments = new Array<{ pair: GroupBookingPair; slot: AvailableSlot } | null>(pairsThisRound.length).fill(
    null,
  );

  pairsThisRound.forEach((pr, idx) => {
    const prevCourt = previousCourtForPair(proposedSoFar, pr.userId, pr.partnerId);
    if (prevCourt != null && remainingCourts.has(prevCourt)) {
      assignments[idx] = { pair: pr, slot: byCourt.get(prevCourt)! };
      remainingCourts.delete(prevCourt);
    }
  });

  const rankedByPriority = orderByCourtPriority([...remainingCourts].map((c) => byCourt.get(c)!), courtPriority);
  const remainingSlotsByPriority = nextSlotCourts
    ? [...rankedByPriority].sort((a, b) => {
        const aBoth = nextSlotCourts.has(a.court) ? 0 : 1;
        const bBoth = nextSlotCourts.has(b.court) ? 0 : 1;
        return aBoth - bBoth;
      })
    : rankedByPriority;

  let cursor = 0;
  pairsThisRound.forEach((pr, idx) => {
    if (assignments[idx]) return;
    assignments[idx] = { pair: pr, slot: remainingSlotsByPriority[cursor]! };
    cursor += 1;
  });

  return assignments as Array<{ pair: GroupBookingPair; slot: AvailableSlot }>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && npx vitest run src/planning/courtAssignment.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/planning/courtAssignment.ts apps/worker/src/planning/courtAssignment.test.ts
git commit -m "feat(planning): port resolveCourtAssignments (continuité de court)"
```

---

### Task 6: Moteur principal `computeGroupBookingPlan`

**Files:**
- Create: `apps/worker/src/planning/groupBookingPlan.ts`
- Test: `apps/worker/src/planning/groupBookingPlan.test.ts`

**Interfaces:**
- Consumes: `buildPairsForGroupBooking` (Task 3), `resolveCourtAssignments`/`AvailableSlot` (Task 5), `parseTeamrTime`/`formatTeamrTimeFromMinutes`/`slotStartDateIsoHeuristicParis` (Task 4), `courtsNeededForPlayers` (Task 2), `SQUASH_COURT_COUNT`/`SQUASH_SLOT_MINUTES` (Task 2), `GroupBookingPlan` type de `apps/worker/src/mcp/resaSquash.ts` (inchangé)
- Produces: `ComputeGroupBookingPlanInput`, `computeGroupBookingPlan(input: ComputeGroupBookingPlanInput): GroupBookingPlan` — c'est la fonction que `bookSlots.ts` appellera (Task 8).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/planning/groupBookingPlan.test.ts
import { describe, expect, it } from "vitest";
import { computeGroupBookingPlan, type ComputeGroupBookingPlanInput } from "./groupBookingPlan.js";
import type { AvailableSlot } from "./courtAssignment.js";

function baseInput(overrides: Partial<ComputeGroupBookingPlanInput> = {}): ComputeGroupBookingPlanInput {
  return {
    groupId: "group-1",
    onDate: "2026-08-04",
    expectedPlayerIds: [],
    substitutePlayerIds: [],
    slotsPerPlayer: 2,
    maxCourts: 3,
    preferMinPlayersPerCourt: false,
    courtPriority: [4, 3, 2, 1],
    startTime: "18H45",
    availableSlots: [],
    usedSessionIds: new Set(),
    apiUserId: null,
    apiUserDailyCount: 0,
    maxDailyReservationsPerPlayer: 2,
    ...overrides,
  };
}

function makeSlots(courts: number[], beginTime: string, endTime: string): AvailableSlot[] {
  return courts.map((court) => ({ sessionId: `s-${court}-${beginTime}`, court, beginTime, endTime }));
}

describe("computeGroupBookingPlan", () => {
  it("2 joueurs, 2 courts libres sur 2 créneaux successifs : 2 réservations, même court", () => {
    const availableSlots = [
      ...makeSlots([4, 3], "18H45", "19H30"),
      ...makeSlots([4, 3], "19H30", "20H15"),
    ];
    const plan = computeGroupBookingPlan(
      baseInput({ expectedPlayerIds: ["a", "b"], availableSlots }),
    );
    expect(plan.proposedBookings).toHaveLength(2);
    expect(plan.proposedBookings.every((b) => b.court === plan.proposedBookings[0]!.court)).toBe(true);
    expect(plan.proposedBookings.map((b) => b.slotTime)).toEqual(["18H45", "19H30"]);
    expect(plan.meta.pairCount).toBe(1);
    expect(plan.warnings).toEqual([]);
  });

  it("scénario régression exact du bug rapporté 2026-07-28 : 3 confirmés + 2 prête-noms + titulaire à quota, puis 2 confirmés à l'heure suivante — aucun conflit de court possible", () => {
    const availableSlots = [
      ...makeSlots([1, 2, 3, 4], "18H45", "19H30"),
      ...makeSlots([1, 2, 3, 4], "19H30", "20H15"),
      ...makeSlots([1, 2, 3, 4], "20H15", "21H00"),
    ];

    // 18H45 : Vincent (titulaire, à quota), Stéphane, Terence + 2 prête-noms (Sébastien, Mustapha).
    const plan1845 = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["vincent", "stephane", "terence"],
        substitutePlayerIds: ["sebastien", "mustapha"],
        startTime: "18H45",
        availableSlots,
        apiUserId: "vincent",
        apiUserDailyCount: 2, // déjà à quota avant même ce plan
        maxDailyReservationsPerPlayer: 2,
      }),
    );
    // Vincent doit être remplacé par un prête-nom partout où il apparaît, jamais réservé lui-même.
    expect(plan1845.proposedBookings.some((b) => b.userId === "vincent" || b.partnerId === "vincent")).toBe(false);

    const usedSessionIds = new Set(plan1845.proposedBookings.map((b) => b.sessionId));

    // 19H30 : Martin + Tin, en tenant compte des créneaux déjà retenus par le groupe 18H45.
    const plan1930 = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["martin", "tin"],
        startTime: "19H30",
        availableSlots,
        usedSessionIds,
      }),
    );

    // Aucun sessionId du groupe 19H30 ne doit chevaucher un sessionId déjà retenu par le groupe 18H45.
    const overlap = plan1930.proposedBookings.filter((b) => usedSessionIds.has(b.sessionId));
    expect(overlap).toEqual([]);
  });

  it("effectif impair sans prête-nom : rotation, warning explicite, joueur en rotation absent des proposedBookings", () => {
    const availableSlots = [...makeSlots([4], "18H45", "19H30"), ...makeSlots([4], "19H30", "20H15")];
    const plan = computeGroupBookingPlan(
      baseInput({ expectedPlayerIds: ["a", "b", "c"], availableSlots, maxCourts: 1 }),
    );
    expect(plan.meta.rotatingPlayerIds).toEqual(["c"]);
    expect(plan.proposedBookings.some((b) => b.userId === "c" || b.partnerId === "c")).toBe(false);
    expect(plan.warnings.some((w) => w.includes("rotation"))).toBe(true);
  });

  it("aucun créneau disponible : plan vide avec warning, pas d'exception", () => {
    const plan = computeGroupBookingPlan(baseInput({ expectedPlayerIds: ["a", "b"], availableSlots: [] }));
    expect(plan.proposedBookings).toEqual([]);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it("titulaire à quota avec prête-nom disponible : remplacé, warning explicite", () => {
    const availableSlots = makeSlots([4], "18H45", "19H30");
    const plan = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["vincent", "stephane"],
        substitutePlayerIds: ["sebastien"],
        slotsPerPlayer: 1,
        availableSlots,
        apiUserId: "vincent",
        apiUserDailyCount: 2,
        maxDailyReservationsPerPlayer: 2,
      }),
    );
    expect(plan.proposedBookings).toEqual([
      expect.objectContaining({ userId: "sebastien", partnerId: "stephane" }),
    ]);
    expect(plan.warnings.some((w) => w.includes("remplacé par le prête-nom sebastien"))).toBe(true);
  });

  it("titulaire à quota sans prête-nom disponible : réservation ignorée pour cette paire, warning explicite", () => {
    const availableSlots = makeSlots([4], "18H45", "19H30");
    const plan = computeGroupBookingPlan(
      baseInput({
        expectedPlayerIds: ["vincent", "stephane"],
        substitutePlayerIds: [],
        slotsPerPlayer: 1,
        availableSlots,
        apiUserId: "vincent",
        apiUserDailyCount: 2,
        maxDailyReservationsPerPlayer: 2,
      }),
    );
    expect(plan.proposedBookings).toEqual([]);
    expect(plan.warnings.some((w) => w.includes("aucun prête-nom disponible"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && npx vitest run src/planning/groupBookingPlan.test.ts`
Expected: FAIL — module inexistant.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/worker/src/planning/groupBookingPlan.ts
import type { GroupBookingPlan } from "../mcp/resaSquash.js";
import { SQUASH_COURT_COUNT, SQUASH_SLOT_MINUTES } from "./constants.js";
import { resolveCourtAssignments, type AvailableSlot, type ProposedSlot } from "./courtAssignment.js";
import { buildPairsForGroupBooking, type GroupBookingPair } from "./pairing.js";
import { courtsNeededForPlayers } from "./courtsNeeded.js";
import { formatTeamrTimeFromMinutes, parseTeamrTime, slotStartDateIsoHeuristicParis } from "./teamrTime.js";

export interface ComputeGroupBookingPlanInput {
  groupId: string;
  onDate: string;
  expectedPlayerIds: string[];
  substitutePlayerIds: string[];
  /** Objectif : chaque joueur doit apparaître sur au moins N créneaux 45 min. */
  slotsPerPlayer: number;
  maxCourts: number;
  preferMinPlayersPerCourt: boolean;
  courtPriority: number[];
  /** Heure candidate — plancher horaire (les créneaux avant cette heure sont ignorés). */
  startTime: string;
  /** Créneaux disponibles ce jour-là, tous courts confondus (déjà filtrés available === true). */
  availableSlots: AvailableSlot[];
  /** sessionId déjà retenus par une heure candidate précédente dans le même run — jamais reproposés. */
  usedSessionIds: ReadonlySet<string>;
  /** userId du titulaire de la clé API resa-squash, ou null si non connu/non applicable. */
  apiUserId: string | null;
  /** Nombre de réservations déjà existantes ce jour-là pour le titulaire (list_my_reservations_on_date). */
  apiUserDailyCount: number;
  maxDailyReservationsPerPlayer: number;
}

function groupAvailableSlotsByTime(
  slots: AvailableSlot[],
  usedSessionIds: ReadonlySet<string>,
): Map<string, AvailableSlot[]> {
  const m = new Map<string, AvailableSlot[]>();
  for (const s of slots) {
    if (usedSessionIds.has(s.sessionId)) continue;
    const arr = m.get(s.beginTime) ?? [];
    arr.push(s);
    m.set(s.beginTime, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.court - b.court);
  return m;
}

function sortTimeKeys(times: Iterable<string>): string[] {
  return [...times].sort((a, b) => (parseTeamrTime(a) ?? 0) - (parseTeamrTime(b) ?? 0));
}

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

function findEarliestWaveTime(
  sortedTimes: string[],
  byTime: Map<string, AvailableSlot[]>,
  courtsThisRound: number,
  usedTimes: Set<string>,
  claimedThisCall: ReadonlySet<string>,
): string | null {
  for (const t of sortedTimes) {
    if (usedTimes.has(t)) continue;
    if (availableSlotsAtTime(byTime, t, claimedThisCall).length >= courtsThisRound) return t;
  }
  return null;
}

function playersBusyAtSlotTime(proposed: ProposedSlot[], slotTime: string, userId: string, partnerId: string): boolean {
  const want = new Set([userId, partnerId]);
  for (const b of proposed) {
    if (b.slotTime !== slotTime) continue;
    if (want.has(b.userId) || want.has(b.partnerId)) return true;
  }
  return false;
}

function countProposedSlotsForPlayer(proposed: ProposedSlot[], playerId: string): number {
  let n = 0;
  for (const b of proposed) if (b.userId === playerId || b.partnerId === playerId) n += 1;
  return n;
}

/**
 * Propose des réservations groupées (plusieurs paires, plusieurs courts, rounds successifs) pour
 * une heure candidate, en tenant compte des sessionId déjà retenus par une heure candidate
 * précédente du même run (usedSessionIds). Ne réserve rien : sortie prête pour reserve_slot.
 * Port fidèle de resa-squash (group-booking-plan.ts, planGroupBookingsMvp) — sans les vérifications
 * spécifiques à la config groupe resa-squash (appartenance, bornes DB, jour récurrent), sans objet
 * squash-assistant équivalent (voir design doc §5).
 */
export function computeGroupBookingPlan(input: ComputeGroupBookingPlanInput): GroupBookingPlan {
  const warnings: string[] = [];

  const { pairs, rotatingPlayerIds, remainingSubstituteIds } = buildPairsForGroupBooking(
    input.expectedPlayerIds,
    input.substitutePlayerIds,
  );
  const rotatingSet = new Set(rotatingPlayerIds);
  const substituteQueue = [...remainingSubstituteIds];
  if (rotatingPlayerIds.length > 0) {
    warnings.push(
      `Effectif impair sans substitutePlayerIds : rotation sur court sans ligne TeamR pour id(s) : ${rotatingPlayerIds.join(", ")} (convention : dernier joueur dans expectedPlayerIds après dédoublonnage).`,
    );
  }

  const playerSet = new Set<string>();
  for (const p of pairs) {
    playerSet.add(p.userId);
    playerSet.add(p.partnerId);
  }
  for (const r of rotatingPlayerIds) playerSet.add(r);

  const courtsNeededRaw = courtsNeededForPlayers(playerSet.size, input.preferMinPlayersPerCourt);
  const hardCap = Math.min(SQUASH_COURT_COUNT, input.maxCourts);
  const courtsNeeded = Math.min(courtsNeededRaw, hardCap);
  if (courtsNeededRaw > hardCap) {
    warnings.push(`Il faudrait ${courtsNeededRaw} court(s) ; plafond ${hardCap} — plan tronqué.`);
  }

  const startMinutes = parseTeamrTime(input.startTime);
  const filteredSlots =
    startMinutes == null
      ? input.availableSlots
      : input.availableSlots.filter((s) => {
          const m = parseTeamrTime(s.beginTime);
          return m == null || m >= startMinutes;
        });

  const byTime = groupAvailableSlotsByTime(filteredSlots, input.usedSessionIds);
  const sortedTimes = sortTimeKeys(byTime.keys());
  const emptyMeta = {
    courtsNeeded,
    roundsPlanned: 0,
    dryRun: true,
    groupLabel: input.groupId,
    recurringWeekday: new Date(input.onDate).getDay(),
    recurringStartTime: input.startTime,
    slotsPerPlayer: input.slotsPerPlayer,
    groupMinSlotsPerPlayer: input.slotsPerPlayer,
    groupMaxSlotsPerPlayer: input.slotsPerPlayer,
    pairCount: pairs.length,
    rotatingPlayerIds: [...rotatingPlayerIds],
  };
  if (sortedTimes.length === 0) {
    warnings.push("Aucun créneau libre après filtres (heure ciblée / dispos resa-squash).");
    return { dryRun: true, proposedBookings: [], warnings, meta: emptyMeta };
  }

  const proposed: ProposedSlot[] = [];
  const proposedWithMeta: GroupBookingPlan["proposedBookings"] = [];
  const claimedThisCall = new Set<string>();
  let totalRounds = 0;
  const maxRoundsPerLayer = Math.min(8, Math.max(pairs.length * 2, 4));

  planLayers: for (let layer = 0; layer < input.slotsPerPlayer; layer += 1) {
    const usedTimes = new Set<string>();
    let pairCursor = 0;
    let layerRounds = 0;

    while (pairCursor < pairs.length && layerRounds < maxRoundsPerLayer) {
      const remainingPairs = pairs.length - pairCursor;
      const courtsThisRound = Math.min(courtsNeeded, remainingPairs);
      const pairsThisRound = pairs.slice(pairCursor, pairCursor + courtsThisRound);

      let tKey: string | null = null;
      let assignments: ReturnType<typeof resolveCourtAssignments> = null;
      const maxTimeSkips = sortedTimes.length + 2;
      for (let skip = 0; skip < maxTimeSkips; skip += 1) {
        tKey = findEarliestWaveTime(sortedTimes, byTime, courtsThisRound, usedTimes, claimedThisCall);
        if (!tKey) break;
        const pr0 = pairsThisRound[0];
        if (pr0 && playersBusyAtSlotTime(proposed, tKey, pr0.userId, pr0.partnerId)) {
          usedTimes.add(tKey);
          continue;
        }
        const available = availableSlotsAtTime(byTime, tKey, claimedThisCall);
        let nextSlotCourts: Set<number> | null = null;
        if (layer + 1 < input.slotsPerPlayer) {
          const minM = parseTeamrTime(tKey);
          const nextLabel = minM != null ? formatTeamrTimeFromMinutes(minM + SQUASH_SLOT_MINUTES) : null;
          if (nextLabel && byTime.has(nextLabel)) {
            nextSlotCourts = new Set(availableSlotsAtTime(byTime, nextLabel, claimedThisCall).map((s) => s.court));
          }
        }
        assignments = resolveCourtAssignments(available, pairsThisRound, proposed, input.courtPriority, nextSlotCourts);
        if (!assignments) {
          usedTimes.add(tKey);
          continue;
        }
        break;
      }

      if (!tKey || !assignments) {
        warnings.push(
          `Couche ${layer + 1}/${input.slotsPerPlayer} (objectif ≥${input.slotsPerPlayer} créneaux 45 min / joueur) : pas assez de courts libres à un horaire utilisable (${pairCursor}/${pairs.length} paires placées).`,
        );
        break planLayers;
      }

      for (const { pair: pr, slot } of assignments) {
        const startDate = slotStartDateIsoHeuristicParis(input.onDate, slot.beginTime);
        if (!startDate) {
          pairCursor += 1;
          continue;
        }

        let userId = pr.userId;
        let partnerId = pr.partnerId;
        const apiUserSlot: "userId" | "partnerId" | null =
          input.apiUserId && pr.userId === input.apiUserId
            ? "userId"
            : input.apiUserId && pr.partnerId === input.apiUserId
              ? "partnerId"
              : null;

        if (apiUserSlot && input.apiUserId) {
          const already = proposed.filter((b) => b.userId === input.apiUserId || b.partnerId === input.apiUserId)
            .length;
          if (input.apiUserDailyCount + already >= input.maxDailyReservationsPerPlayer) {
            const sub = substituteQueue.shift();
            if (sub) {
              if (apiUserSlot === "userId") userId = sub;
              else partnerId = sub;
              warnings.push(
                `Titulaire clé API : plafond ${input.maxDailyReservationsPerPlayer} résas ce jour atteint — remplacé par le prête-nom ${sub} pour cette paire (${slot.beginTime}).`,
              );
            } else {
              warnings.push(
                `Titulaire clé API : plafond ${input.maxDailyReservationsPerPlayer} résas ce jour atteint — réservation ignorée pour cette paire (${slot.beginTime}), aucun prête-nom disponible.`,
              );
              pairCursor += 1;
              continue;
            }
          }
        }

        const proposedSlot: ProposedSlot = { userId, partnerId, court: slot.court, slotTime: slot.beginTime, slotEndTime: slot.endTime };
        proposed.push(proposedSlot);
        proposedWithMeta.push({
          sessionId: slot.sessionId,
          userId,
          partnerId,
          startDate,
          court: slot.court,
          slotTime: slot.beginTime,
          slotEndTime: slot.endTime,
          groupId: input.groupId,
        });
        claimedThisCall.add(slot.sessionId);
        pairCursor += 1;
      }

      usedTimes.add(tKey);
      layerRounds += 1;
      totalRounds += 1;

      if (pairCursor >= pairs.length) break;
    }

    if (pairCursor < pairs.length) {
      warnings.push(
        `Couche ${layer + 1}/${input.slotsPerPlayer} : ${pairs.length - pairCursor} paire(s) non placée(s) dans cette couche.`,
      );
      break;
    }
  }

  for (const pid of playerSet) {
    if (rotatingSet.has(pid)) continue;
    const n = countProposedSlotsForPlayer(proposed, pid);
    if (n < input.slotsPerPlayer) {
      warnings.push(
        `Objectif : chaque joueur ≥${input.slotsPerPlayer} créneau(x) TeamR de ${SQUASH_SLOT_MINUTES} min — id ${pid} : ${n} réservation(s) proposée(s).`,
      );
    }
  }

  return {
    dryRun: true,
    proposedBookings: proposedWithMeta,
    warnings,
    meta: { ...emptyMeta, roundsPlanned: totalRounds },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && npx vitest run src/planning/groupBookingPlan.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `./node_modules/.bin/tsc -p apps/worker/tsconfig.build.json --noEmit`
Expected: aucune erreur.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/planning/groupBookingPlan.ts apps/worker/src/planning/groupBookingPlan.test.ts
git commit -m "feat(planning): moteur local computeGroupBookingPlan (port fidèle)"
```

---

### Task 7: Nouveau builder de paramètres (`buildGroupBookingPlanParams`)

**Files:**
- Create: `apps/worker/src/graph/buildGroupBookingPlanParams.ts`
- Create: `apps/worker/src/graph/buildGroupBookingPlanParams.test.ts`
- Delete: `apps/worker/src/graph/buildBookingParams.ts`, `apps/worker/src/graph/buildBookingParams.test.ts` (remplacés)

**Interfaces:**
- Consumes: `prioritizePlayers` (déjà existant, `apps/worker/src/graph/playerPriority.ts`, inchangé), `BookingRule` (`@squash-assistant/db/schema`)
- Produces: `GroupBookingPlanParams` (sous-ensemble de `ComputeGroupBookingPlanInput` sans `availableSlots`/`usedSessionIds`/`apiUserId`/`apiUserDailyCount`, ajoutés dans `bookSlots.ts`), `buildGroupBookingPlanParams(rule, confirmedPlayerIds, targetDate, startTime, preferMinPlayersPerCourtOverride?, usedTodayIds?, volunteerSubstituteIds?): GroupBookingPlanParams`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/graph/buildGroupBookingPlanParams.test.ts
import { describe, expect, it } from "vitest";
import bookingRules from "../../../../packages/db/seeds/booking-rules.seed.json" with { type: "json" };
import type { BookingRule } from "@squash-assistant/db/schema";
import { buildGroupBookingPlanParams } from "./buildGroupBookingPlanParams.js";

const rules = bookingRules as BookingRule[];

function ruleById(id: string): BookingRule {
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new Error(`Règle "${id}" introuvable dans booking-rules.json`);
  return rule;
}

describe("buildGroupBookingPlanParams", () => {
  it("squashacademie-mardi : Martin et Vincent réservataires prioritaires", () => {
    const rule = ruleById("squashacademie-mardi");
    const confirmed = ["user-tin", "60e23b69a78d1100206b808c", "60bf2fdd1fd8d20020d2c8a7"];
    const params = buildGroupBookingPlanParams(rule, confirmed, "2026-07-21", "18H45");

    expect(params.groupId).toBe(rule.resaSquashGroupId);
    expect(params.onDate).toBe("2026-07-21");
    expect(params.slotsPerPlayer).toBe(2);
    expect(params.startTime).toBe("18H45");
    expect(params.maxCourts).toBe(rule.maxCourtsPerSlot);
    expect(params.preferMinPlayersPerCourt).toBe(rule.preferMinPlayersPerCourt);
    expect(params.courtPriority).toEqual(rule.courtPriority);
    expect(params.maxDailyReservationsPerPlayer).toBe(rule.maxDailyReservationsPerPlayer);
    // priorityBookers = [Vincent, Martin] → dans cet ordre en tête.
    expect(params.expectedPlayerIds.slice(0, 2)).toEqual(["60bf2fdd1fd8d20020d2c8a7", "60e23b69a78d1100206b808c"]);
    expect(params.expectedPlayerIds).toContain("user-tin");
  });

  it("exclut de substitutePlayerIds les prête-noms déjà confirmés ou déjà utilisés ce jour-là", () => {
    const rule: BookingRule = { ...ruleById("squash-samedi-matin"), substituteBookers: ["sub-a", "sub-b", "sub-c"] };
    const confirmed = ["user-x", "sub-b"];
    const usedTodayIds = new Set(["sub-c"]);

    const params = buildGroupBookingPlanParams(rule, confirmed, "2026-07-18", "10H30", undefined, usedTodayIds);

    expect(params.substitutePlayerIds).toEqual(["sub-a"]);
  });

  it("priorise les prête-noms volontaires du sondage avant les substituteBookers par défaut", () => {
    const rule: BookingRule = { ...ruleById("squash-samedi-matin"), substituteBookers: ["default-a", "default-b"] };

    const params = buildGroupBookingPlanParams(
      rule,
      ["user-x", "user-y"],
      "2026-07-18",
      "10H30",
      undefined,
      new Set(),
      ["volunteer-1", "volunteer-2"],
    );

    expect(params.substitutePlayerIds).toEqual(["volunteer-1", "volunteer-2", "default-a", "default-b"]);
  });

  it("preferMinPlayersPerCourtOverride écrase rule.preferMinPlayersPerCourt", () => {
    const rule = ruleById("squashacademie-mardi");
    const params = buildGroupBookingPlanParams(rule, ["user-x", "user-y"], "2026-07-21", "18H45", false);
    expect(params.preferMinPlayersPerCourt).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && npx vitest run src/graph/buildGroupBookingPlanParams.test.ts`
Expected: FAIL — module inexistant.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/worker/src/graph/buildGroupBookingPlanParams.ts
import type { BookingRule } from "../config.js";
import type { ComputeGroupBookingPlanInput } from "../planning/groupBookingPlan.js";
import { prioritizePlayers } from "./playerPriority.js";

/** Sous-ensemble de ComputeGroupBookingPlanInput dérivable d'une BookingRule — availableSlots/usedSessionIds/apiUserId/apiUserDailyCount sont ajoutés dans bookSlots.ts (données d'I/O, pas de config). */
export type GroupBookingPlanParams = Omit<
  ComputeGroupBookingPlanInput,
  "availableSlots" | "usedSessionIds" | "apiUserId" | "apiUserDailyCount"
>;

/**
 * Construit les paramètres du moteur local à partir d'une BookingRule, des joueurs confirmés
 * pour une heure candidate donnée (CollectVotes) et de cette heure elle-même — logique pure,
 * testable sans mock MCP. Remplace buildBookingParams.ts (params MCP plan_group_bookings).
 */
export function buildGroupBookingPlanParams(
  rule: BookingRule,
  confirmedPlayerIds: string[],
  targetDate: string,
  startTime: string,
  /** Écrase rule.preferMinPlayersPerCourt — utilisé par l'escalade min→max (ADR-014). */
  preferMinPlayersPerCourtOverride?: boolean,
  /** Prête-noms déjà mobilisés ce jour-là (voir ADR-016) — jamais reproposés comme substitut. */
  usedTodayIds: ReadonlySet<string> = new Set(),
  /** Prête-noms volontaires du sondage de la semaine (ADR-017) — prioritaires sur rule.substituteBookers. */
  volunteerSubstituteIds: string[] = [],
): GroupBookingPlanParams {
  const eligible = (id: string) => !usedTodayIds.has(id) && !confirmedPlayerIds.includes(id);
  const volunteers = volunteerSubstituteIds.filter(eligible);
  const volunteerSet = new Set(volunteers);
  const defaults = rule.substituteBookers.filter((id) => eligible(id) && !volunteerSet.has(id));
  const substitutePlayerIds = [...volunteers, ...defaults];
  return {
    groupId: rule.resaSquashGroupId,
    onDate: targetDate,
    expectedPlayerIds: prioritizePlayers(confirmedPlayerIds, rule.priorityBookers),
    substitutePlayerIds,
    slotsPerPlayer: rule.maxReservationsPerPlayer,
    startTime,
    maxCourts: rule.maxCourtsPerSlot,
    preferMinPlayersPerCourt: preferMinPlayersPerCourtOverride ?? rule.preferMinPlayersPerCourt,
    courtPriority: rule.courtPriority,
    maxDailyReservationsPerPlayer: rule.maxDailyReservationsPerPlayer,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && npx vitest run src/graph/buildGroupBookingPlanParams.test.ts`
Expected: PASS

- [ ] **Step 5: Retirer l'ancien builder**

```bash
git rm apps/worker/src/graph/buildBookingParams.ts apps/worker/src/graph/buildBookingParams.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/graph/buildGroupBookingPlanParams.ts apps/worker/src/graph/buildGroupBookingPlanParams.test.ts
git commit -m "feat(graph): buildGroupBookingPlanParams remplace buildBookingParams (moteur local)"
```

---

### Task 8: Wire `bookSlots.ts` sur le moteur local, retirer la détection de conflit

**Files:**
- Modify: `apps/worker/src/graph/nodes/bookSlots.ts`
- Modify: `apps/worker/src/graph/capacityPlanning.ts` (retire `courtIntervalsFromPlan`, `conflictingSessionIds`, `busyCourtsDuring`, `CourtInterval`)
- Modify: `apps/worker/src/graph/capacityPlanning.test.ts` (retire les tests des fonctions supprimées)
- Modify: `apps/worker/src/graph/state.ts` (retire `conflictingSessionIds` de `BookingPlanGroup`)
- Modify: `apps/worker/src/graph/nodes/announce.ts` (retire la gestion de `conflictingSessionIds`)
- Modify: `apps/worker/src/graph/nodes/bookSlots.test.ts` (réécrit pour mocker `listAvailability`/`listMyReservationsOnDate` au lieu de `planGroupBookings`)
- Modify: `apps/worker/src/graph/nodes/announce.test.ts` (retire le scénario `conflictingSessionIds` absent — devenu sans objet, le champ n'existe plus)
- Modify: `apps/ui/src/lib/worker.ts`, `apps/ui/src/app/rules/[id]/jobs/[jobId]/Pipeline.tsx` (retire `conflictingSessionIds`)

**Interfaces:**
- Consumes: `computeGroupBookingPlan`/`ComputeGroupBookingPlanInput` (Task 6), `buildGroupBookingPlanParams` (Task 7), `listAvailability`/`listMyReservationsOnDate`/`AvailabilitySlot` (Task 1)

- [ ] **Step 1: Réécrire `bookSlots.ts`**

Remplacer le contenu de `apps/worker/src/graph/nodes/bookSlots.ts` par :

```typescript
import { listAvailability, listMyReservationsOnDate, type AvailabilitySlot, type GroupBookingPlan } from "../../mcp/resaSquash.js";
import { sendTelegramMessage } from "../../telegram/telegram.js";
import { buildGroupBookingPlanParams } from "../buildGroupBookingPlanParams.js";
import { computeShortfall, countPlayersInSessions, splitByAvailabilityWindow } from "../capacityPlanning.js";
import { withEventLogging } from "../emitEvent.js";
import { computeGroupBookingPlan, type ComputeGroupBookingPlanInput } from "../../planning/groupBookingPlan.js";
import type { AvailableSlot } from "../../planning/courtAssignment.js";
import type { GraphDependencies } from "../dependencies.js";
import type { BookingPlanGroup } from "../state.js";
import type { PipelineStateType } from "../state.js";
import type { BookingRule } from "../../config.js";

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

function toAvailableSlot(slot: AvailabilitySlot): AvailableSlot {
  return { sessionId: slot.id, court: slot.court, beginTime: slot.time, endTime: slot.endTime };
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
  apiUserDailyCount: number,
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
  const input: ComputeGroupBookingPlanInput = { ...params, availableSlots, usedSessionIds, apiUserId, apiUserDailyCount };
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
  const escalatedPlan = computeGroupBookingPlan({ ...escalatedParams, availableSlots, usedSessionIds, apiUserId, apiUserDailyCount });
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

export function createBookSlotsNode(deps: GraphDependencies) {
  return async (state: PipelineStateType): Promise<Partial<PipelineStateType>> => {
    const { bookingRule, jobRunId, targetDate, confirmedPlayerIdsByTime, volunteerSubstituteIds } = state;

    const bookingPlanGroups = await withEventLogging(
      deps,
      { bookingRuleId: bookingRule.id, jobRunId, type: "booking", targetDate },
      async () => {
        const { availability } = await listAvailability(deps.resaSquash.client, targetDate, targetDate);
        const availableSlots = availability.flatMap((day) => day.slots.filter((s) => s.available).map(toAvailableSlot));

        const { userId: apiUserId, reservations: apiUserReservations } = await listMyReservationsOnDate(
          deps.resaSquash.client,
          targetDate,
        );
        const apiUserDailyCount = apiUserReservations.length;

        const groups: BookingPlanGroup[] = [];
        const usedTodayIds = new Set<string>(Object.values(confirmedPlayerIdsByTime).flat());
        const usedSessionIds = new Set<string>();

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
            apiUserDailyCount,
          );
          for (const id of substitutesUsedInPlan(bookingRule, volunteerSubstituteIds, plan, confirmedPlayerIds)) {
            usedTodayIds.add(id);
          }
          const { outOfWindowSessionIds } = splitByAvailabilityWindow(plan, startTime, bookingRule.availabilityWindowHours);
          for (const b of plan.proposedBookings) {
            if (!outOfWindowSessionIds.includes(b.sessionId)) usedSessionIds.add(b.sessionId);
          }
          groups.push({ startTime, plan, outOfWindowSessionIds });
        }
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

export function hasProposedBookings(state: PipelineStateType): boolean {
  return (state.bookingPlanGroups ?? []).some((g) => g.plan.proposedBookings.length > 0);
}
```

Note : `usedSessionIds` (partagé entre heures candidates) remplace entièrement `busyCourtsDuring`/`conflictingSessionIds` — un `sessionId` déjà ajouté à `usedSessionIds` n'apparaît plus dans `byTime` du moteur local pour l'heure candidate suivante (filtré dans `groupAvailableSlotsByTime`), donc plus aucun double-booking possible entre heures candidates.

- [ ] **Step 2: Retirer le code de détection de conflit devenu mort**

Dans `apps/worker/src/graph/capacityPlanning.ts`, retirer les exports `CourtInterval`, `courtIntervalsFromPlan`, `conflictingSessionIds`, `busyCourtsDuring` (gardent `parseTeamrTime`, `computeShortfall`, `splitByAvailabilityWindow`, `countPlayersInSessions`, inchangés).

Dans `apps/worker/src/graph/capacityPlanning.test.ts`, retirer le bloc `describe("courtIntervalsFromPlan / conflictingSessionIds / busyCourtsDuring...")`.

Dans `apps/worker/src/graph/state.ts`, retirer le champ `conflictingSessionIds` de `BookingPlanGroup` (garder `outOfWindowSessionIds`).

Dans `apps/worker/src/graph/nodes/announce.ts`, remplacer :

```typescript
const allProposedBookings = groups.flatMap((g) =>
  g.plan.proposedBookings.filter(
    (b) => !g.outOfWindowSessionIds.includes(b.sessionId) && !(g.conflictingSessionIds ?? []).includes(b.sessionId),
  ),
);
const unplacedPlayerCount = groups.reduce(
  (n, g) =>
    n +
    computeShortfall(g.plan) +
    countPlayersInSessions(g.plan, g.outOfWindowSessionIds) +
    countPlayersInSessions(g.plan, g.conflictingSessionIds ?? []),
  0,
);
```

par (retire la partie `conflictingSessionIds`) :

```typescript
const allProposedBookings = groups.flatMap((g) =>
  g.plan.proposedBookings.filter((b) => !g.outOfWindowSessionIds.includes(b.sessionId)),
);
const unplacedPlayerCount = groups.reduce(
  (n, g) => n + computeShortfall(g.plan) + countPlayersInSessions(g.plan, g.outOfWindowSessionIds),
  0,
);
```

Dans `apps/worker/src/graph/nodes/announce.test.ts`, retirer le test `"n'explose pas et annonce normalement un plan dont conflictingSessionIds est absent"` et sa fonction `legacyGroupWithoutConflictField` (le champ n'existe plus du tout, ce scénario n'a plus lieu d'être).

Dans `apps/ui/src/lib/worker.ts`, retirer `conflictingSessionIds` de l'interface `BookingPlanGroup`.

Dans `apps/ui/src/app/rules/[id]/jobs/[jobId]/Pipeline.tsx`, retirer toutes les références à `g.conflictingSessionIds` (2 endroits : filtre de `mergeBookingsByCourt`, variable `conflicting` dans le détail par heure votée) — revenir à la version qui ne teste que `g.outOfWindowSessionIds`.

- [ ] **Step 3: Réécrire `bookSlots.test.ts`**

```typescript
// apps/worker/src/graph/nodes/bookSlots.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingRule } from "@squash-assistant/db/schema";
import type { GraphDependencies } from "../dependencies.js";
import type { PipelineStateType } from "../state.js";

const listAvailabilityMock = vi.fn();
const listMyReservationsOnDateMock = vi.fn();

vi.mock("../../mcp/resaSquash.js", () => ({
  listAvailability: (...args: unknown[]) => listAvailabilityMock(...args),
  listMyReservationsOnDate: (...args: unknown[]) => listMyReservationsOnDateMock(...args),
}));

vi.mock("../../telegram/telegram.js", () => ({
  sendTelegramMessage: vi.fn(async () => {}),
}));

const { createBookSlotsNode } = await import("./bookSlots.js");

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
    candidateStartTimes: ["18H45", "19H30"],
    maxCourtsPerSlot: 3,
    minPlayersPerCourt: 2,
    maxPlayersPerCourt: 2,
    maxReservationsPerPlayer: 2,
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

function deps(): GraphDependencies {
  return {
    huddleBot: { client: {} as never, close: async () => {} },
    resaSquash: { client: {} as never, close: async () => {} },
    telegram: { botToken: "test-token", chatId: "test-chat" },
    db: { insert: () => ({ values: async () => {} }) } as never,
  };
}

function baseState(bookingRule: BookingRule): PipelineStateType {
  return {
    bookingRule,
    jobRunId: "job-1",
    targetDate: "2026-07-21",
    pollRequestId: "poll-1",
    confirmedPlayerIdsByTime: {
      "18H45": ["vincent", "stephane", "terence"],
      "19H30": ["martin", "tin"],
    },
    volunteerSubstituteIds: ["sebastien", "mustapha"],
    bookingPlanGroups: undefined,
    goConfirmed: false,
    dryRun: true,
    announceMessage: undefined,
  };
}

function slot(id: string, court: number, time: string, endTime: string, available = true) {
  return { id, court, time, endTime, date: "2026-07-21", participants: available ? 0 : 2, available, users: [] };
}

describe("createBookSlotsNode — moteur local", () => {
  beforeEach(() => {
    listAvailabilityMock.mockReset();
    listMyReservationsOnDateMock.mockReset();
  });

  it("scénario régression du bug rapporté 2026-07-28 : titulaire à quota, aucun conflit de court entre 18H45 et 19H30", async () => {
    listAvailabilityMock.mockResolvedValue({
      availability: [
        {
          date: "2026-07-21",
          slots: [
            slot("s1-1845", 1, "18H45", "19H30"),
            slot("s2-1845", 2, "18H45", "19H30"),
            slot("s3-1845", 3, "18H45", "19H30"),
            slot("s4-1845", 4, "18H45", "19H30"),
            slot("s1-1930", 1, "19H30", "20H15"),
            slot("s2-1930", 2, "19H30", "20H15"),
            slot("s3-1930", 3, "19H30", "20H15"),
            slot("s4-1930", 4, "19H30", "20H15"),
            slot("s1-2015", 1, "20H15", "21H00"),
            slot("s2-2015", 2, "20H15", "21H00"),
            slot("s3-2015", 3, "20H15", "21H00"),
            slot("s4-2015", 4, "20H15", "21H00"),
          ],
        },
      ],
    });
    listMyReservationsOnDateMock.mockResolvedValue({
      userId: "vincent",
      onDate: "2026-07-21",
      timeZone: "Europe/Paris",
      reservations: [{ sessionId: "elsewhere-1" }, { sessionId: "elsewhere-2" }], // déjà 2 résas ce jour → à quota
    });

    const node = createBookSlotsNode(deps());
    const result = await node(baseState(rule()));
    const groups = result.bookingPlanGroups ?? [];

    expect(groups).toHaveLength(2);
    const allSessionIds = groups.flatMap((g) => g.plan.proposedBookings.map((b) => b.sessionId));
    // Aucun sessionId ne peut apparaître deux fois — le double-booking devient structurellement
    // impossible (usedSessionIds partagé entre heures candidates), pas juste détecté après coup.
    expect(new Set(allSessionIds).size).toBe(allSessionIds.length);
    // Vincent (à quota) n'est jamais réservé lui-même.
    expect(allSessionIds.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.plan.proposedBookings.some((b) => b.userId === "vincent" || b.partnerId === "vincent")).toBe(false);
    }
  });

  it("pas assez de joueurs confirmés : aucun appel au moteur pour cette heure, warning explicite", async () => {
    listAvailabilityMock.mockResolvedValue({ availability: [{ date: "2026-07-21", slots: [] }] });
    listMyReservationsOnDateMock.mockResolvedValue({ userId: "vincent", reservations: [] });

    const state = baseState(rule({ candidateStartTimes: ["18H45"] }));
    state.confirmedPlayerIdsByTime = { "18H45": ["solo"] };

    const node = createBookSlotsNode(deps());
    const result = await node(state);
    const group = (result.bookingPlanGroups ?? [])[0]!;

    expect(group.plan.proposedBookings).toEqual([]);
    expect(group.plan.warnings[0]).toContain("Pas assez de joueurs confirmés");
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/worker && npx vitest run`
Expected: PASS (tous les tests, y compris ceux non touchés par cette tâche).

- [ ] **Step 5: Typecheck (worker + UI)**

Run: `./node_modules/.bin/tsc -p apps/worker/tsconfig.build.json --noEmit`
Run: `./node_modules/.bin/tsc -p apps/ui/tsconfig.json --noEmit`
Expected: aucune erreur des deux côtés.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/graph/nodes/bookSlots.ts apps/worker/src/graph/nodes/bookSlots.test.ts \
        apps/worker/src/graph/capacityPlanning.ts apps/worker/src/graph/capacityPlanning.test.ts \
        apps/worker/src/graph/state.ts apps/worker/src/graph/nodes/announce.ts apps/worker/src/graph/nodes/announce.test.ts \
        apps/ui/src/lib/worker.ts "apps/ui/src/app/rules/[id]/jobs/[jobId]/Pipeline.tsx"
git commit -m "feat(worker): bookSlots appelle le moteur local, retire la détection de conflit devenue inutile"
```

---

### Task 9: Retirer `plan_group_bookings`/`planGroupSession` du client MCP et du script de démo

**Files:**
- Modify: `apps/worker/src/mcp/resaSquash.ts` (retire `PlanGroupBookingsParams`, `planGroupBookings`, `planGroupSession`)
- Modify: `apps/worker/src/scripts/test-mcp-connections.ts`

**Interfaces:**
- Consumes: rien de nouveau
- Produces: rien (suppression)

- [ ] **Step 1: Vérifier qu'aucun appelant ne reste**

Run: `grep -rn "planGroupBookings\|planGroupSession\|PlanGroupBookingsParams" apps/worker/src apps/ui/src --include="*.ts" --include="*.tsx"`
Expected: aucune occurrence en dehors de `apps/worker/src/mcp/resaSquash.ts` lui-même et de `apps/worker/src/scripts/test-mcp-connections.ts` (traité à l'étape suivante).

- [ ] **Step 2: Retirer les exports du client MCP**

Dans `apps/worker/src/mcp/resaSquash.ts`, supprimer les fonctions `planGroupSession` et `planGroupBookings`, ainsi que l'interface `PlanGroupBookingsParams`. Garder `GroupBookingPlan` (toujours le type de retour de `computeGroupBookingPlan`, Task 6) et `reserveSlot`/`cancelReservation` inchangés.

- [ ] **Step 3: Adapter le script de démo**

Dans `apps/worker/src/scripts/test-mcp-connections.ts`, remplacer le bloc appelant `planGroupBookings` par un appel `listAvailability` :

```typescript
import { loadEnv } from "../config.js";
import { connectHuddleBot, listGroups } from "../mcp/huddleBot.js";
import { connectResaSquash, listAvailability, listGroupMembers, listMyGroups } from "../mcp/resaSquash.js";

async function main(): Promise<void> {
  const env = loadEnv();

  console.log("[test-mcp] Connexion à huddle-bot...");
  const huddleBot = await connectHuddleBot(env.huddleBotMcpUrl, env.huddleBotMcpApiKey);
  try {
    const { groups } = await listGroups(huddleBot.client);
    console.log(`[test-mcp] huddle-bot list_groups → ${groups.length} groupe(s)`);
    console.log(groups);
  } finally {
    await huddleBot.close();
  }

  console.log("[test-mcp] Connexion à resa-squash...");
  const resaSquash = await connectResaSquash(env.resaSquashMcpUrl, env.resaSquashMcpApiKey);
  try {
    const { groups } = await listMyGroups(resaSquash.client);
    console.log(`[test-mcp] resa-squash list_my_groups → ${groups.length} groupe(s)`);
    console.log(groups);

    if (groups.length > 0) {
      const { members } = await listGroupMembers(resaSquash.client, groups[0].groupId);
      console.log(`[test-mcp] resa-squash list_group_members → ${members.length} membre(s)`);

      const onDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { availability } = await listAvailability(resaSquash.client, onDate, onDate);
      console.log(`[test-mcp] resa-squash list_availability pour ${onDate} :`);
      console.log(availability);
    }
  } finally {
    await resaSquash.close();
  }
}

main().catch((err) => {
  console.error("[test-mcp] erreur :", err);
  process.exit(1);
});
```

- [ ] **Step 4: Typecheck**

Run: `./node_modules/.bin/tsc -p apps/worker/tsconfig.build.json --noEmit`
Expected: aucune erreur.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/mcp/resaSquash.ts apps/worker/src/scripts/test-mcp-connections.ts
git commit -m "chore(mcp): retire plan_group_bookings/plan_group_session du client (moteur local en place)"
```

---

### Task 10: Suite de tests complète + vérification finale

**Files:** aucun nouveau fichier — vérification transverse.

- [ ] **Step 1: Lancer toute la suite worker**

Run: `cd apps/worker && npx vitest run`
Expected: 100% des tests passent (aucune régression sur les fichiers non touchés : `capacityPlanning.test.ts` restant, `playerPriority.test.ts`, `slotMerge.test.ts`, `pollQuestion.test.ts`).

- [ ] **Step 2: Typecheck worker + UI**

Run: `./node_modules/.bin/tsc -p apps/worker/tsconfig.build.json --noEmit`
Run: `./node_modules/.bin/tsc -p apps/ui/tsconfig.json --noEmit`
Expected: aucune erreur des deux côtés.

- [ ] **Step 3: Vérifier qu'aucune référence morte ne subsiste**

Run: `grep -rn "conflictingSessionIds\|busyCourtsDuring\|courtIntervalsFromPlan\|CourtInterval" apps/worker/src apps/ui/src --include="*.ts" --include="*.tsx"`
Expected: aucune occurrence.

- [ ] **Step 4: Commit (si des ajustements ont été nécessaires)**

```bash
git add -A
git commit -m "test: vérification finale suite au portage du moteur de plan local" --allow-empty
```

---

### Task 11: Mettre à jour `docs/spec/regles-fonctionnelles.md`

**Files:**
- Modify: `docs/spec/regles-fonctionnelles.md` §4 ("Étape 3 — Plan de réservation")

- [ ] **Step 1: Mettre à jour la section §4**

Remplacer la phrase d'ouverture de §4 :

> "Calculer le plan" déclenche, pour chaque heure candidate ayant au moins un joueur confirmé, un appel `plan_group_bookings` en dry-run (`dryRun: true` toujours à ce stade) → produit un `bookingPlanGroups: Array<{ startTime, plan: { proposedBookings, warnings } }>`.

par :

> "Calculer le plan" appelle `list_availability` (une fois par job, sur toute la plage horaire du jour cible) et `list_my_reservations_on_date` (quota du titulaire de la clé API), puis, pour chaque heure candidate ayant au moins un joueur confirmé, invoque le moteur de planification local (`apps/worker/src/planning/`) — port fidèle de l'algorithme auparavant délégué à `plan_group_bookings` (MCP resa-squash, toujours disponible pour OpenClaw, non modifié) → produit un `bookingPlanGroups: Array<{ startTime, plan: { proposedBookings, warnings } }>`. Les `sessionId` déjà retenus par une heure candidate précédente du même run sont exclus des heures candidates suivantes, rendant le double-booking de court entre deux heures candidates structurellement impossible.

Mettre à jour le paragraphe "Continuité de court sur créneaux successifs" : remplacer *"implémentée côté resa-squash"* et la référence à `resolveCourtAssignments` dans `group-booking-plan.ts` (repo resa-squash) par une référence au module local `apps/worker/src/planning/courtAssignment.ts` (même algorithme, porté).

Mettre à jour le paragraphe "Prête-noms en repli du quota titulaire" (ADR-016) : remplacer les références à *"resa-squash les consomme"* / [ADR-010 resa-squash] par une référence à `apps/worker/src/planning/groupBookingPlan.ts` (même logique, portée localement — ADR-010 resa-squash reste la référence historique du comportement d'origine, à citer comme telle).

Ajouter une ligne dans le tableau "Historique des décisions notables" en fin de document :

```markdown
| 2026-07-29 | Étape 3 : moteur de calcul du plan de réservation rapatrié côté squash-assistant (`apps/worker/src/planning/`), resa-squash devient un service de réservation unitaire (`list_availability`/`reserve_slot`/`cancel_reservation`) | La logique d'allocation (appariement, court, rotation, quota) vivait entièrement dans `plan_group_bookings`, hors de portée de test côté squash-assistant — voir ADR-018 |
```

- [ ] **Step 2: Commit**

```bash
git add docs/spec/regles-fonctionnelles.md
git commit -m "docs: met à jour les règles fonctionnelles pour le moteur de plan local"
```

---

### Task 12: Rédiger l'ADR-018

**Files:**
- Create: `docs/adr/ADR-018-moteur-de-plan-de-reservation-local.md`

- [ ] **Step 1: Invoquer le skill de rédaction d'ADR**

Utiliser `trustview-write-adr` (ou, à défaut, suivre le format des ADR existants dans `docs/adr/ADR-017-*.md`) pour rédiger l'ADR-018, documentant : le contexte (bug de double-booking ayant révélé que l'allocation vivait hors de portée de test), la décision (port fidèle du moteur dans squash-assistant, resa-squash devient un service de réservation unitaire), les conséquences (bascule directe, `plan_group_bookings` non retiré de resa-squash mais non appelé, coexistence OpenClaw inchangée — voir ADR-007), et un lien vers ce plan d'implémentation et la spec associée (`docs/superpowers/specs/2026-07-29-local-group-booking-plan-engine-design.md`).

- [ ] **Step 2: Commit**

```bash
git add docs/adr/ADR-018-moteur-de-plan-de-reservation-local.md
git commit -m "docs: ADR-018 — moteur de plan de réservation rapatrié côté squash-assistant"
```

---

## Rollout final

Une fois les 12 tâches validées : `git push origin main` déclenche le build/déploiement CI habituel (`build-push.yml`, GitOps `kubernetes/deployment.yaml`). Vérifier après déploiement, sur un job réel en `awaiting-go`, que le plan calculé ne diffère pas de façon inattendue du comportement `plan_group_bookings` historique (mêmes règles portées à l'identique) — utiliser le bouton "Recalculer le plan" pour comparer si un job existant est encore disponible.
