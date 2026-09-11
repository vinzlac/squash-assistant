# Planification pilotée par la date cible — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer les 3 champs pilotés par le cron (`pollCron`, `decisionCron`, `targetWeekdayOffset`) par 5 champs pilotés par la date cible (`targetWeekday`, `pollDaysBefore`, `pollTime`, `decisionDaysBefore`, `decisionTime`) ; les crons deviennent dérivés.

**Architecture:** Une fonction pure partagée (`packages/db/src/ruleSchedule.ts`) dérive les crons et valide les invariants ; le scheduler du worker l'utilise à la place des crons stockés ; une migration Drizzle convertit les règles existantes en SQL ; l'UI, l'extraction LLM et la description en français basculent sur les 5 nouveaux champs. Le pipeline LangGraph, le jitter, l'idempotence par `(règle, targetDate)` et le rappel J+1 ne changent pas.

**Tech Stack:** TypeScript (npm workspaces), Drizzle ORM + migrations SQL, node-cron, vitest, Next.js (server actions + un composant client), Anthropic tool-use (extraction).

**Spec:** `docs/superpowers/specs/2026-09-11-target-driven-schedule-design.md`

## Global Constraints

- Jours de la semaine : convention JS/cron, `0 = dimanche … 6 = samedi`.
- Heures au format `"HH:MM"` (regex `^([01]\d|2[0-3]):[0-5]\d$`), fuseau `Europe/Paris`.
- Invariants : `N ≥ 1`, `0 ≤ M ≤ N`, si `M == N` alors `decisionTime > pollTime`.
- Migration : `packages/db/src/migrations/0024_target_driven_schedule.sql`, appliquée par l'initContainer (ADR-012) — **ne jamais** écrire dans la doc « lancer `db:migrate` » (sauf dev local).
- Appel MCP resa-squash **inchangé** (pas de flag `force` dans cette itération).
- Commits : format `<type>: <description>` ; pas de secrets ; `npm run typecheck` et `npm test` verts à la fin de chaque tâche marquée « typecheck ».
- Règle AGENTS.md : après modification de code, `graphify update .` (tâche 9).

**Ordre imposé :** les tâches 2 → 7 cassent le typecheck tant que toutes les références aux anciens champs ne sont pas migrées. Pour garder un état vert par commit, la tâche 2 change le schéma **et** toutes les fixtures/tests en même temps (gros commit mécanique), puis chaque tâche suivante rebranche un consommateur.

---

### Task 1 : `ruleSchedule.ts` — fonctions pures partagées (dérivation des crons + validation)

**Files:**
- Create: `packages/db/src/ruleSchedule.ts`
- Create: `packages/db/src/ruleSchedule.test.ts`
- Modify: `packages/db/package.json` (bloc `exports`)

**Interfaces:**
- Produces:
  ```ts
  export interface RuleSchedule {
    targetWeekday: number;      // 0–6
    pollDaysBefore: number;     // N ≥ 1
    pollTime: string;           // "HH:MM"
    decisionDaysBefore: number; // 0 ≤ M ≤ N
    decisionTime: string;       // "HH:MM"
  }
  export const WEEKDAY_NAMES_FR: readonly string[]; // ["dimanche", …, "samedi"]
  export function triggerWeekday(targetWeekday: number, daysBefore: number): number;
  export function deriveCrons(s: RuleSchedule): { pollCron: string; decisionCron: string };
  export function validateRuleSchedule(s: RuleSchedule): string[]; // [] = valide
  ```

- [ ] **Step 1 : Écrire les tests (RED)**

`packages/db/src/ruleSchedule.test.ts` :

```ts
import { describe, expect, it } from "vitest";
import { deriveCrons, triggerWeekday, validateRuleSchedule, type RuleSchedule } from "./ruleSchedule.js";

const mardi: RuleSchedule = {
  targetWeekday: 2,
  pollDaysBefore: 7,
  pollTime: "10:00",
  decisionDaysBefore: 7,
  decisionTime: "21:30",
};

describe("triggerWeekday", () => {
  it("mardi − 7 = mardi (squashacademie-mardi)", () => {
    expect(triggerWeekday(2, 7)).toBe(2);
  });
  it("samedi − 4 = mardi (squash-samedi-matin)", () => {
    expect(triggerWeekday(6, 4)).toBe(2);
  });
  it("dimanche − 1 = samedi (wrap-around négatif)", () => {
    expect(triggerWeekday(0, 1)).toBe(6);
  });
  it("mardi − 9 = dimanche (plus d'une semaine avant)", () => {
    expect(triggerWeekday(2, 9)).toBe(0);
  });
  it("M = 0 → le jour cible lui-même", () => {
    expect(triggerWeekday(3, 0)).toBe(3);
  });
});

describe("deriveCrons", () => {
  it("reproduit les crons historiques de squashacademie-mardi", () => {
    expect(deriveCrons(mardi)).toEqual({ pollCron: "0 10 * * 2", decisionCron: "30 21 * * 2" });
  });
  it("reproduit les crons historiques de squash-samedi-matin (N = M = 4)", () => {
    expect(
      deriveCrons({ targetWeekday: 6, pollDaysBefore: 4, pollTime: "10:00", decisionDaysBefore: 4, decisionTime: "21:30" }),
    ).toEqual({ pollCron: "0 10 * * 2", decisionCron: "30 21 * * 2" });
  });
  it("N ≠ M : sondage dimanche J-9, décision mardi J-7", () => {
    expect(deriveCrons({ ...mardi, pollDaysBefore: 9, decisionDaysBefore: 7 })).toEqual({
      pollCron: "0 10 * * 0",
      decisionCron: "30 21 * * 2",
    });
  });
  it("ne perd pas le zéro initial des minutes (09:05 → « 5 9 »)", () => {
    expect(deriveCrons({ ...mardi, pollTime: "09:05" }).pollCron).toBe("5 9 * * 2");
  });
});

describe("validateRuleSchedule", () => {
  it("accepte une règle cohérente", () => {
    expect(validateRuleSchedule(mardi)).toEqual([]);
  });
  it("refuse M > N", () => {
    expect(validateRuleSchedule({ ...mardi, decisionDaysBefore: 8 })).toContain(
      "La décision (8 j avant) ne peut pas précéder le sondage (7 j avant).",
    );
  });
  it("refuse N < 1", () => {
    expect(validateRuleSchedule({ ...mardi, pollDaysBefore: 0, decisionDaysBefore: 0 })).toContain(
      "Le sondage doit être lancé au moins 1 jour avant la date cible.",
    );
  });
  it("refuse M = N avec l'heure de décision avant celle du sondage", () => {
    expect(validateRuleSchedule({ ...mardi, decisionTime: "09:00" })).toContain(
      "Même jour : l'heure de décision (09:00) doit être après l'heure du sondage (10:00).",
    );
  });
  it("accepte M = N avec l'heure de décision après celle du sondage", () => {
    expect(validateRuleSchedule({ ...mardi, decisionTime: "10:01" })).toEqual([]);
  });
  it("refuse un jour cible hors 0–6 et une heure mal formée", () => {
    const errors = validateRuleSchedule({ ...mardi, targetWeekday: 7, pollTime: "10h00" });
    expect(errors).toContain("Jour cible invalide : 7 (attendu 0 = dimanche … 6 = samedi).");
    expect(errors).toContain("Heure du sondage invalide : « 10h00 » (attendu HH:MM).");
  });
});
```

- [ ] **Step 2 : Vérifier que ça échoue**

Run: `npm test -w packages/db -- ruleSchedule`
Expected: FAIL — `Cannot find module './ruleSchedule.js'`

- [ ] **Step 3 : Implémenter**

`packages/db/src/ruleSchedule.ts` :

```ts
/**
 * Planification pilotée par la date cible (ADR-030) : la règle dit quel jour
 * de la semaine on veut jouer et combien de jours avant on sonde / on décide ;
 * les crons sont dérivés d'ici, jamais stockés. Fonctions pures, partagées
 * entre le worker (cronRegistry), les actions serveur de l'UI (validation) et
 * l'aperçu du formulaire de règle.
 */
export interface RuleSchedule {
  /** 0 = dimanche … 6 = samedi (convention JS/cron). */
  targetWeekday: number;
  /** N : le sondage part N jours avant la date cible (≥ 1). */
  pollDaysBefore: number;
  /** "HH:MM", Europe/Paris. */
  pollTime: string;
  /** M : collecte des votes + plan M jours avant la date cible (0 ≤ M ≤ N). */
  decisionDaysBefore: number;
  /** "HH:MM", Europe/Paris. */
  decisionTime: string;
}

export const WEEKDAY_NAMES_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Jour de déclenchement = (jour cible − N) mod 7, toujours dans [0, 6] même pour N > 7. */
export function triggerWeekday(targetWeekday: number, daysBefore: number): number {
  return (((targetWeekday - daysBefore) % 7) + 7) % 7;
}

function cronFor(time: string, weekday: number): string {
  const [hour, minute] = time.split(":").map(Number);
  return `${minute} ${hour} * * ${weekday}`;
}

/** Expressions node-cron (5 champs) du sondage et de la décision. Suppose `validateRuleSchedule(s)` vide. */
export function deriveCrons(s: RuleSchedule): { pollCron: string; decisionCron: string } {
  return {
    pollCron: cronFor(s.pollTime, triggerWeekday(s.targetWeekday, s.pollDaysBefore)),
    decisionCron: cronFor(s.decisionTime, triggerWeekday(s.targetWeekday, s.decisionDaysBefore)),
  };
}

/** Liste des violations d'invariants, en français (vide = valide). */
export function validateRuleSchedule(s: RuleSchedule): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(s.targetWeekday) || s.targetWeekday < 0 || s.targetWeekday > 6) {
    errors.push(`Jour cible invalide : ${s.targetWeekday} (attendu 0 = dimanche … 6 = samedi).`);
  }
  if (!TIME_RE.test(s.pollTime)) {
    errors.push(`Heure du sondage invalide : « ${s.pollTime} » (attendu HH:MM).`);
  }
  if (!TIME_RE.test(s.decisionTime)) {
    errors.push(`Heure de décision invalide : « ${s.decisionTime} » (attendu HH:MM).`);
  }
  if (!Number.isInteger(s.pollDaysBefore) || s.pollDaysBefore < 1) {
    errors.push("Le sondage doit être lancé au moins 1 jour avant la date cible.");
  }
  if (!Number.isInteger(s.decisionDaysBefore) || s.decisionDaysBefore < 0) {
    errors.push("Le décalage de la décision doit être un entier ≥ 0.");
  } else if (s.decisionDaysBefore > s.pollDaysBefore) {
    errors.push(
      `La décision (${s.decisionDaysBefore} j avant) ne peut pas précéder le sondage (${s.pollDaysBefore} j avant).`,
    );
  } else if (
    s.decisionDaysBefore === s.pollDaysBefore &&
    TIME_RE.test(s.pollTime) &&
    TIME_RE.test(s.decisionTime) &&
    s.decisionTime <= s.pollTime
  ) {
    errors.push(
      `Même jour : l'heure de décision (${s.decisionTime}) doit être après l'heure du sondage (${s.pollTime}).`,
    );
  }
  return errors;
}
```

Ajouter l'export dans `packages/db/package.json`, après `./ruleDescription` :

```json
    "./ruleSchedule": {
      "types": "./dist/ruleSchedule.d.ts",
      "default": "./dist/ruleSchedule.js"
    },
```

- [ ] **Step 4 : Vérifier (GREEN)**

Run: `npm test -w packages/db -- ruleSchedule`
Expected: PASS (15 tests)

- [ ] **Step 5 : Commit**

```bash
git add packages/db/src/ruleSchedule.ts packages/db/src/ruleSchedule.test.ts packages/db/package.json
git commit -m "feat(db): ruleSchedule — dérivation des crons et validation depuis la date cible"
```

---

### Task 2 : Schéma, migration 0024, fixtures et helpers de test

**Files:**
- Modify: `packages/db/src/schema.ts:22-31` (interface) et `:83-91` (table)
- Create: `packages/db/src/migrations/0024_target_driven_schedule.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `packages/db/src/fixtures/realRules.ts:16-18,44-46,72-74`
- Modify: `packages/db/seeds/booking-rules.seed.json` (chaque règle)
- Modify (helpers `rule()` de tests, remplacement mécanique des 3 lignes) :
  `apps/worker/src/scheduler/cronRegistry.test.ts:44-46`, `apps/worker/src/scheduler/scheduler.test.ts:45-47`,
  `apps/worker/src/graph/nodes/announce.test.ts:90-92`, `apps/worker/src/graph/nodes/bookSlots.test.ts:48-50`,
  `apps/worker/src/graph/nodes/sendPoll.test.ts:37-39`, `apps/worker/src/planning/planJob.test.ts:13-15`,
  `apps/worker/src/planning/scenarios.regression.test.ts:36-38`, `apps/worker/src/planning/simulateScenario.test.ts:12-14`,
  `apps/worker/src/scripts/test-graph.ts:189-191`

**Interfaces:**
- Produces : `BookingRule` avec `targetWeekday: number; pollDaysBefore: number; pollTime: string; decisionDaysBefore: number; decisionTime: string;` — **sans** `pollCron`, `decisionCron`, `targetWeekdayOffset`.

- [ ] **Step 1 : Schéma — interface**

Dans `packages/db/src/schema.ts`, remplacer les 3 lignes `pollCron: string; decisionCron: string; targetWeekdayOffset: number;` de l'interface par :

```ts
  /**
   * Planification pilotée par la date cible (ADR-030) : la règle dit quel jour
   * de la semaine on joue ; le sondage et la décision sont déclenchés N / M jours
   * avant, aux heures indiquées. Les crons sont dérivés (ruleSchedule.ts), jamais stockés.
   * Invariants : N ≥ 1, 0 ≤ M ≤ N, et si M = N alors decisionTime > pollTime.
   */
  /** 0 = dimanche … 6 = samedi. */
  targetWeekday: number;
  /** N : jours entre le lancement du sondage et la date cible. */
  pollDaysBefore: number;
  /** "HH:MM" Europe/Paris. */
  pollTime: string;
  /** M : jours entre la décision (collecte + plan + go + réservation) et la date cible. */
  decisionDaysBefore: number;
  /** "HH:MM" Europe/Paris. */
  decisionTime: string;
```

- [ ] **Step 2 : Schéma — table**

Remplacer `pollCron: text("poll_cron").notNull(), decisionCron: text("decision_cron").notNull(), targetWeekdayOffset: integer("target_weekday_offset").notNull(),` par :

```ts
  targetWeekday: integer("target_weekday").notNull(),
  pollDaysBefore: integer("poll_days_before").notNull(),
  pollTime: text("poll_time").notNull(),
  decisionDaysBefore: integer("decision_days_before").notNull(),
  decisionTime: text("decision_time").notNull(),
```

- [ ] **Step 3 : Migration SQL (écrite à la main — conversion de données)**

`packages/db/src/migrations/0024_target_driven_schedule.sql` :

```sql
-- ADR-030 : planification pilotée par la date cible. Les crons stockés (poll_cron,
-- decision_cron) et target_weekday_offset sont convertis en jour cible + décalages en jours
-- + heures, puis supprimés. Format garanti des crons existants : "MM HH * * D" (validation UI),
-- sauf les sentinelles "0 0 1 1 *" des règles désactivées (jour '*' non castable → valeurs par défaut).
ALTER TABLE "booking_rules" ADD COLUMN "target_weekday" integer;--> statement-breakpoint
ALTER TABLE "booking_rules" ADD COLUMN "poll_days_before" integer;--> statement-breakpoint
ALTER TABLE "booking_rules" ADD COLUMN "poll_time" text;--> statement-breakpoint
ALTER TABLE "booking_rules" ADD COLUMN "decision_days_before" integer;--> statement-breakpoint
ALTER TABLE "booking_rules" ADD COLUMN "decision_time" text;--> statement-breakpoint
-- 1) Sentinelles (jour de semaine '*') : règle désactivée, valeurs neutres.
UPDATE "booking_rules" SET
  "target_weekday" = 0,
  "poll_days_before" = 7,
  "poll_time" = '00:00',
  "decision_days_before" = 7,
  "decision_time" = '00:00',
  "enabled" = false
WHERE split_part("poll_cron", ' ', 5) !~ '^[0-6]$' OR split_part("decision_cron", ' ', 5) !~ '^[0-6]$';--> statement-breakpoint
-- 2) Conversion des crons hebdomadaires réels.
UPDATE "booking_rules" SET
  "poll_time" = lpad(split_part("poll_cron", ' ', 2), 2, '0') || ':' || lpad(split_part("poll_cron", ' ', 1), 2, '0'),
  "decision_time" = lpad(split_part("decision_cron", ' ', 2), 2, '0') || ':' || lpad(split_part("decision_cron", ' ', 1), 2, '0'),
  "target_weekday" = (split_part("poll_cron", ' ', 5)::int + "target_weekday_offset") % 7,
  "poll_days_before" = "target_weekday_offset",
  "decision_days_before" = "target_weekday_offset"
    - ((split_part("decision_cron", ' ', 5)::int - split_part("poll_cron", ' ', 5)::int + 7) % 7)
WHERE "target_weekday" IS NULL;--> statement-breakpoint
-- 3) Résultat négatif = décision configurée avant le sondage dans la semaine (incohérent dans
-- l'ancien modèle : elle visait une autre date cible) → repli « même jour que le sondage ».
UPDATE "booking_rules" SET "decision_days_before" = "poll_days_before"
WHERE "decision_days_before" < 0;--> statement-breakpoint
ALTER TABLE "booking_rules" ALTER COLUMN "target_weekday" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_rules" ALTER COLUMN "poll_days_before" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_rules" ALTER COLUMN "poll_time" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_rules" ALTER COLUMN "decision_days_before" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_rules" ALTER COLUMN "decision_time" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_rules" DROP COLUMN "poll_cron";--> statement-breakpoint
ALTER TABLE "booking_rules" DROP COLUMN "decision_cron";--> statement-breakpoint
ALTER TABLE "booking_rules" DROP COLUMN "target_weekday_offset";
```

Note pour l'implémenteur : sur les 5 règles réelles en base (toutes « même jour »), le 3e `UPDATE` ne touche aucune ligne. Vérifier ce point en dev local (Step 6).

Ajouter l'entrée dans `packages/db/src/migrations/meta/_journal.json` après l'entrée `0023_joker_booker` :

```json
    {
      "idx": 24,
      "version": "7",
      "when": 1789084800000,
      "tag": "0024_target_driven_schedule",
      "breakpoints": true
    }
```

Snapshot Drizzle : lancer `npm run db:generate -w packages/db` **avant** d'écrire le SQL ci-dessus génère un `0024_<nom-aléatoire>.sql` + `meta/0024_snapshot.json` ; renommer le SQL en `0024_target_driven_schedule.sql`, remplacer son contenu par celui ci-dessus, et corriger le `tag` dans `_journal.json`. Garder le snapshot généré.

- [ ] **Step 4 : Fixtures réelles, seed JSON, script test-graph**

`packages/db/src/fixtures/realRules.ts` — remplacer les 3 lignes de chaque règle :

```ts
    // squashacademie-mardi (ex. "0 10 * * 2" / "30 21 * * 2" / offset 7)
    targetWeekday: 2,
    pollDaysBefore: 7,
    pollTime: "10:00",
    decisionDaysBefore: 7,
    decisionTime: "21:30",
```
```ts
    // squash-samedi-matin (ex. "0 10 * * 2" / "30 21 * * 2" / offset 4 → samedi)
    targetWeekday: 6,
    pollDaysBefore: 4,
    pollTime: "10:00",
    decisionDaysBefore: 4,
    decisionTime: "21:30",
```
```ts
    // test-vincent-all (ex. sentinelle "0 0 1 1 *", règle désactivée)
    targetWeekday: 0,
    pollDaysBefore: 7,
    pollTime: "00:00",
    decisionDaysBefore: 7,
    decisionTime: "00:00",
```

Mettre à jour le commentaire d'en-tête du fichier : « Paramètres réels des 3 règles en prod au 2026-07-22, convertis au modèle ADR-030 le 2026-09-11 ».

`packages/db/seeds/booking-rules.seed.json` : pour chaque règle, remplacer `"pollCron"`, `"decisionCron"`, `"targetWeekdayOffset"` par les 5 clés JSON équivalentes (mêmes valeurs que les fixtures ci-dessus, en se basant sur les crons présents dans le fichier — appliquer la même conversion : `targetWeekday = (jour_poll + offset) % 7`, `pollDaysBefore = offset`, `decisionDaysBefore = offset − ((jour_dec − jour_poll + 7) % 7)`).

`apps/worker/src/scripts/test-graph.ts:189-191` → même bloc que squashacademie-mardi.

- [ ] **Step 5 : Helpers `rule()` des tests worker (remplacement mécanique)**

Dans chacun des 8 fichiers de test listés, remplacer les 3 lignes `pollCron / decisionCron / targetWeekdayOffset` par :

- `cronRegistry.test.ts`, `scheduler.test.ts`, `announce.test.ts`, `bookSlots.test.ts`, `sendPoll.test.ts`, `scenarios.regression.test.ts`, `simulateScenario.test.ts` :
  ```ts
    targetWeekday: 2,
    pollDaysBefore: 7,
    pollTime: "10:00",
    decisionDaysBefore: 7,
    decisionTime: "21:30",
  ```
- `planJob.test.ts` (ancien : poll samedi, offset 1 → dimanche) :
  ```ts
    targetWeekday: 0,
    pollDaysBefore: 1,
    pollTime: "10:00",
    decisionDaysBefore: 1,
    decisionTime: "21:30",
  ```

Attention `cronRegistry.test.ts` : le helper utilisait `"0 0 1 1 *"` (cron qui ne tire jamais) — node-cron est mocké dans ce test, donc l'expression réelle n'a pas d'importance ; les assertions `find((c) => c.expr === "0 10 * * 2")` restent valides avec la dérivation (mardi, N = 7 → mardi 10:00). Ce fichier ne compilera que quand `cronRegistry.ts` sera migré (Task 4) — c'est attendu ; la Task 4 rétablit le vert.

- [ ] **Step 6 : Vérifier la migration en local**

```bash
docker compose up -d postgres
npm run db:migrate -w packages/db
psql "$DATABASE_URL" -c "select id, target_weekday, poll_days_before, poll_time, decision_days_before, decision_time, enabled from booking_rules order by id;"
```

Expected (si la base locale contient les règles réelles) : `squashacademie-mardi → 2, 7, 10:00, 7, 21:30` ; `squash-samedi-matin → 6, 4, 10:00, 4, 21:30` ; règles sentinelles → `0, 7, 00:00, 7, 00:00, f`. Si la base est vide, `npm run db:seed -w packages/db` puis relancer la requête pour vérifier au moins que le seed passe sur le nouveau schéma.

- [ ] **Step 7 : Build du package db et typecheck partiel**

Run: `npm run build -w packages/db && npm test -w packages/db`
Expected : build OK ; tests `ruleDescription.test.ts` **échouent** (ils lisent encore `pollCron`) — corrigés en Task 3.

- [ ] **Step 8 : Commit**

```bash
git add packages/db apps/worker/src/scripts/test-graph.ts apps/worker/src/**/*.test.ts
git commit -m "feat(db): schéma et migration 0024 — planification pilotée par la date cible (ADR-030)"
```

---

### Task 3 : `ruleDescription.ts` — description en français depuis le nouveau modèle

**Files:**
- Modify: `packages/db/src/ruleDescription.ts:1-23` (supprimer `describeCron` et `WEEKDAY_NAMES_FR` local) et `:72-73`
- Modify: `packages/db/src/ruleDescription.test.ts:6-24`

**Interfaces:**
- Consumes : `WEEKDAY_NAMES_FR`, `triggerWeekday` de `./ruleSchedule.js` (Task 1).

- [ ] **Step 1 : Adapter les tests (RED)**

Dans `packages/db/src/ruleDescription.test.ts`, remplacer les assertions des deux premiers tests :

```ts
  it("squashacademie-mardi : jour cible, sondage et décision J-7 avec leurs heures, priorité des courts", () => {
    const text = describeRuleInFrench(REAL_RULES["squashacademie-mardi"]!);
    expect(text).toContain("La réservation vise chaque mardi");
    expect(text).toContain("7 jour(s) avant, le mardi à 10:00");
    expect(text).toContain("7 jour(s) avant, le mardi à 21:30");
    // (garder ici les assertions existantes sur les heures candidates / priorité des courts)
  });

  it("squash-samedi-matin : jour cible samedi, sondage et décision J-4 (mardi)", () => {
    const text = describeRuleInFrench(REAL_RULES["squash-samedi-matin"]!);
    expect(text).toContain("La réservation vise chaque samedi");
    expect(text).toContain("4 jour(s) avant, le mardi à 10:00");
    expect(text).toContain("4 jour(s) avant, le mardi à 21:30");
    // (garder les assertions existantes : une seule heure candidate, 1 réservataire prioritaire)
  });
```

Supprimer les `expect(text).toContain("J+7")` / `"J+4"` / `"mardi à 10H00"` / `"mardi à 21H30"`.

- [ ] **Step 2 : Vérifier que ça échoue**

Run: `npm test -w packages/db -- ruleDescription`
Expected : FAIL (compilation : `rule.pollCron` n'existe plus, puis assertions).

- [ ] **Step 3 : Implémenter**

En tête de `ruleDescription.ts` : supprimer la constante `WEEKDAY_NAMES_FR` locale et la fonction `describeCron` ; ajouter :

```ts
import { WEEKDAY_NAMES_FR, triggerWeekday } from "./ruleSchedule.js";

/** « 7 jour(s) avant, le mardi à 10:00 » — même dérivation que le scheduler. */
function describeTrigger(rule: BookingRule, daysBefore: number, time: string): string {
  const day = WEEKDAY_NAMES_FR[triggerWeekday(rule.targetWeekday, daysBefore)];
  return `${daysBefore} jour(s) avant, le ${day} à ${time}`;
}
```

Remplacer les deux lignes du tableau `lines` qui utilisaient `describeCron` par :

```ts
    `La réservation vise chaque ${WEEKDAY_NAMES_FR[rule.targetWeekday]}, avec comme heures candidates : ${rule.candidateStartTimes.join(", ")}.`,
    `Le sondage WhatsApp ("qui joue ?") est envoyé ${describeTrigger(rule, rule.pollDaysBefore, rule.pollTime)}.`,
    `La collecte des votes puis le calcul du plan de réservation se déclenchent ${describeTrigger(rule, rule.decisionDaysBefore, rule.decisionTime)}.`,
```

- [ ] **Step 4 : Vérifier (GREEN)**

Run: `npm test -w packages/db`
Expected : PASS (tout le package).

- [ ] **Step 5 : Commit**

```bash
git add packages/db/src/ruleDescription.ts packages/db/src/ruleDescription.test.ts
git commit -m "feat(db): description en français depuis le jour cible et les décalages N/M"
```

---

### Task 4 : Scheduler worker — crons dérivés et `targetDate` par décalage

**Files:**
- Modify: `apps/worker/src/scheduler/cronRegistry.ts:1-10,72-100,137-139`
- Modify: `apps/worker/src/scheduler/scheduler.ts:207,224`
- Modify: `apps/worker/src/scheduler/cronRegistry.test.ts` (nouveau test)

**Interfaces:**
- Consumes : `deriveCrons` de `@squash-assistant/db/ruleSchedule`.

- [ ] **Step 1 : Test (RED) — les crons enregistrés sont dérivés**

Ajouter dans `cronRegistry.test.ts`, dans le `describe("cronRegistry reload à chaud")` :

```ts
  it("dérive les crons du jour cible : samedi, sondage J-4 → mardi 10:00, décision J-2 → jeudi 21:30", async () => {
    scheduledCronCalls.length = 0;
    startCronRegistry(
      [rule({ id: "samedi", targetWeekday: 6, pollDaysBefore: 4, pollTime: "10:00", decisionDaysBefore: 2, decisionTime: "21:30" })],
      { graph: {} as never, telegram: {} as never, db: {} as never, onPoll: vi.fn(async () => {}), onDecision: vi.fn(async () => {}), onReminder: vi.fn(async () => {}) },
    );
    expect(scheduledCronCalls.map((c) => c.expr)).toEqual(["0 10 * * 2", "30 21 * * 4", "5 0 * * *"]);
  });
```

(Adapter la forme de l'appel `startCronRegistry(...)` à celle déjà utilisée dans les autres tests du fichier — reprendre exactement le même objet runtime qu'eux.)

- [ ] **Step 2 : Vérifier que ça échoue**

Run: `npm test -w apps/worker -- cronRegistry`
Expected : FAIL (compilation sur `rule.pollCron` dans `cronRegistry.ts`).

- [ ] **Step 3 : Implémenter `cronRegistry.ts`**

Import :
```ts
import { deriveCrons } from "@squash-assistant/db/ruleSchedule";
```

Dans `scheduleOne`, juste après `const ruleId = rule.id;` :
```ts
  // Crons dérivés du jour cible (ADR-030) — jamais stockés en base.
  const { pollCron, decisionCron } = deriveCrons(rule);
```
Remplacer `cron.schedule(rule.pollCron, …)` par `cron.schedule(pollCron, …)` et `cron.schedule(rule.decisionCron, …)` par `cron.schedule(decisionCron, …)`.

Log final :
```ts
  console.log(
    `[scheduler] planifié « ${ruleId} » cible=${rule.targetWeekday} poll=${pollCron} (J-${rule.pollDaysBefore}) decision=${decisionCron} (J-${rule.decisionDaysBefore}) jitter=${rule.cronJitterWindowMinutes ?? 60}min`,
  );
```

- [ ] **Step 4 : Implémenter `scheduler.ts`**

`triggerCronSendPoll` : `const targetDate = computeTargetDate(new Date(), rule.pollDaysBefore);`
`triggerCronDecision` : `const targetDate = computeTargetDate(new Date(), rule.decisionDaysBefore);`

Ajouter au-dessus de `triggerCronDecision` :
```ts
/**
 * Le cron de décision tire `decisionDaysBefore` jours avant la cible : comme le cron de
 * sondage est dérivé du même `targetWeekday`, les deux retombent sur la même targetDate
 * et retrouvent le même job — y compris quand N ≠ M (ADR-030). Si la règle a été modifiée
 * entre les deux (jour cible ou M), il peut n'y avoir aucun job : on logue et on s'arrête,
 * le job restant déclenchable à la main depuis l'UI.
 */
```

- [ ] **Step 5 : Vérifier (GREEN)**

Run: `npm test -w apps/worker -- scheduler` puis `npm run typecheck -w apps/worker`
Expected : tests scheduler/cronRegistry PASS ; typecheck échoue **uniquement** sur `http/server.ts:273` (`targetWeekdayOffset`) et `llm/ruleParamsExtraction.ts` — traités en Tasks 5 et 6.

- [ ] **Step 6 : Commit**

```bash
git add apps/worker/src/scheduler
git commit -m "feat(scheduler): crons dérivés du jour cible, targetDate par décalage N/M"
```

---

### Task 5 : Job manuel — prochaine occurrence du jour cible

**Files:**
- Modify: `apps/worker/src/scheduler/weekKey.ts` (ajout `nextWeekdayDate`)
- Modify: `apps/worker/src/scheduler/weekKey.test.ts`
- Modify: `apps/worker/src/http/server.ts:25,273`

**Interfaces:**
- Produces : `export function nextWeekdayDate(now: Date, targetWeekday: number): string` — `"YYYY-MM-DD"`, prochaine occurrence **strictement après** aujourd'hui (calendrier Europe/Paris).

- [ ] **Step 1 : Test (RED)**

Ajouter dans `weekKey.test.ts` :

```ts
import { computeTargetDate, computeWeekKey, nextWeekdayDate, parisCalendarDayBoundsUtc } from "./weekKey.js";

describe("nextWeekdayDate", () => {
  it("mardi 14/07 → samedi 18/07", () => {
    expect(nextWeekdayDate(new Date("2026-07-14T10:00:00Z"), 6)).toBe("2026-07-18");
  });
  it("aujourd'hui = jour cible → la semaine suivante, jamais aujourd'hui", () => {
    expect(nextWeekdayDate(new Date("2026-07-14T10:00:00Z"), 2)).toBe("2026-07-21");
  });
  it("raisonne en calendrier Europe/Paris (dimanche 22h30 UTC = lundi 00h30 Paris)", () => {
    // Lundi 20/07 à Paris → prochain mardi = 21/07 (en UTC on serait encore dimanche 19 → mardi 21 aussi,
    // mais le prochain lundi serait 20/07 en UTC contre 27/07 à Paris).
    expect(nextWeekdayDate(new Date("2026-07-19T22:30:00Z"), 1)).toBe("2026-07-27");
  });
});
```

- [ ] **Step 2 : Vérifier que ça échoue**

Run: `npm test -w apps/worker -- weekKey`
Expected : FAIL — `nextWeekdayDate is not a function`.

- [ ] **Step 3 : Implémenter**

Dans `weekKey.ts`, après `computeTargetDate` :

```ts
/**
 * Prochaine occurrence du jour de semaine cible strictement après aujourd'hui
 * (Europe/Paris) — date cible par défaut d'un job créé à la main (ADR-030).
 */
export function nextWeekdayDate(now: Date, targetWeekday: number): string {
  const date = parisCalendarDate(now);
  const delta = ((targetWeekday - date.getUTCDay() + 7) % 7) || 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
```

Dans `server.ts` : import `import { nextWeekdayDate } from "../scheduler/weekKey.js";` (remplacer `computeTargetDate` si plus utilisé ailleurs dans le fichier — vérifier avec `grep -n computeTargetDate apps/worker/src/http/server.ts`) et dans `handleCreateJob` :

```ts
  // Prochaine occurrence du jour cible (ADR-030) — modifiable ensuite via handleEditJob tant que le sondage n'est pas parti.
  const targetDate = nextWeekdayDate(new Date(), rule.targetWeekday);
```

- [ ] **Step 4 : Vérifier (GREEN)**

Run: `npm test -w apps/worker -- weekKey && npm run typecheck -w apps/worker`
Expected : weekKey PASS ; typecheck ne reste rouge que sur `llm/ruleParamsExtraction.ts`.

- [ ] **Step 5 : Commit**

```bash
git add apps/worker/src/scheduler/weekKey.ts apps/worker/src/scheduler/weekKey.test.ts apps/worker/src/http/server.ts
git commit -m "feat(worker): job manuel daté sur la prochaine occurrence du jour cible"
```

---

### Task 6 : Extraction LLM des paramètres de règle

**Files:**
- Modify: `apps/worker/src/llm/ruleParamsExtraction.ts:11-30,37-52,54-70,106-113`
- Modify: `apps/worker/src/llm/ruleParamsExtraction.integration.test.ts:23-25`

- [ ] **Step 1 : Adapter le test d'intégration**

Remplacer les 3 lignes `expect(extracted.pollCron…) / decisionCron / targetWeekdayOffset` par :

```ts
      expect(extracted.targetWeekday).toBe(rule.targetWeekday);
      expect(extracted.pollDaysBefore).toBe(rule.pollDaysBefore);
      expect(extracted.pollTime).toBe(rule.pollTime);
      expect(extracted.decisionDaysBefore).toBe(rule.decisionDaysBefore);
      expect(extracted.decisionTime).toBe(rule.decisionTime);
```

(Ce test n'est pas dans `npm test` — il tourne via `npm run test:llm` avec `ANTHROPIC_API_KEY` ; l'exécuter une fois à la fin de la tâche si la clé est disponible en local, sinon le signaler dans le compte-rendu.)

- [ ] **Step 2 : Implémenter le schéma**

`ExtractableRuleParams` : remplacer `| "pollCron" | "decisionCron" | "targetWeekdayOffset"` par
`| "targetWeekday" | "pollDaysBefore" | "pollTime" | "decisionDaysBefore" | "decisionTime"`.

`SYSTEM_PROMPT` : remplacer la phrase « jour/heure du sondage et de la décision (crons), heures candidates, décalage de jour cible, » par « jour de semaine visé pour la réservation, décalages en jours et heures du sondage et de la décision, heures candidates, » et remplacer tout le bloc « CONVERSION JOUR/HEURE → CRON … » par :

```
JOUR CIBLE ET DÉCLENCHEMENTS :
- "La réservation vise chaque mardi" → targetWeekday = 2 (dimanche=0, lundi=1, mardi=2, mercredi=3, jeudi=4, vendredi=5, samedi=6).
- "Le sondage … est envoyé 7 jour(s) avant, le mardi à 10:00" → pollDaysBefore = 7, pollTime = "10:00" (le jour cité n'est PAS le jour cible, c'est le jour de déclenchement — ne t'en sers pas pour targetWeekday).
- "La collecte des votes … se déclenchent 4 jour(s) avant, le mardi à 21:30" → decisionDaysBefore = 4, decisionTime = "21:30".
- Les heures sont recopiées telles quelles au format HH:MM, sans jamais perdre les minutes ("21:30" → "21:30", pas "21:00").
```

`INPUT_SCHEMA.properties` : supprimer `pollCron`, `decisionCron`, `targetWeekdayOffset` ; ajouter :

```ts
    targetWeekday: { type: "integer", description: "Jour de semaine visé pour la réservation (dimanche=0 … samedi=6)." },
    pollDaysBefore: { type: "integer", description: "Nombre de jours avant la date cible où le sondage est envoyé." },
    pollTime: { type: "string", description: "Heure d'envoi du sondage, format HH:MM (ex. \"10:00\")." },
    decisionDaysBefore: { type: "integer", description: "Nombre de jours avant la date cible où la collecte des votes et le plan sont lancés." },
    decisionTime: { type: "string", description: "Heure de la décision, format HH:MM (ex. \"21:30\")." },
```

`required` : remplacer `"pollCron", "decisionCron", "targetWeekdayOffset"` par `"targetWeekday", "pollDaysBefore", "pollTime", "decisionDaysBefore", "decisionTime"`.

Description de `cronJitterWindowMinutes` : « Flou horaire en minutes après le déclenchement du sondage (0 = immédiat). … » (plus de mention de `pollCron/decisionCron`).

- [ ] **Step 3 : Vérifier**

Run: `npm run typecheck -w apps/worker && npm test -w apps/worker`
Expected : typecheck vert, tous les tests worker PASS.

- [ ] **Step 4 : Commit**

```bash
git add apps/worker/src/llm
git commit -m "feat(llm): extraction des paramètres de règle sur le modèle jour cible + décalages"
```

---

### Task 7 : UI admin — formulaire de règle, validation, générateur

**Files:**
- Modify: `apps/ui/src/lib/worker.ts:183-185`
- Create: `apps/ui/src/app/components/ScheduleFields.tsx`
- Delete: `apps/ui/src/app/components/CronField.tsx`
- Modify: `apps/ui/src/app/rules/RuleForm.tsx:4,115-121,133-136`
- Modify: `apps/ui/src/app/actions.ts:154-156` (+ validation)
- Modify: `apps/ui/src/app/components/RuleGeneratorPanel.tsx:31-33,60-66,75-77`
- Modify: `apps/ui/src/lib/pipelinePreview.ts:1-24` (supprimer `computeTargetDate` et `parisCalendarDate`, plus aucun appelant)

**Interfaces:**
- Consumes : `WEEKDAY_NAMES_FR`, `triggerWeekday`, `validateRuleSchedule` de `@squash-assistant/db/ruleSchedule`.

- [ ] **Step 1 : Types UI**

`apps/ui/src/lib/worker.ts` : remplacer `pollCron: string; decisionCron: string; targetWeekdayOffset: number;` par
```ts
  targetWeekday: number;
  pollDaysBefore: number;
  pollTime: string;
  decisionDaysBefore: number;
  decisionTime: string;
```

- [ ] **Step 2 : Composant client `ScheduleFields.tsx`**

```tsx
"use client";

import { useState } from "react";
import { WEEKDAY_NAMES_FR, triggerWeekday } from "@squash-assistant/db/ruleSchedule";

interface Props {
  targetWeekday?: number;
  pollDaysBefore?: number;
  pollTime?: string;
  decisionDaysBefore?: number;
  decisionTime?: string;
}

/**
 * Bloc « Planification » du formulaire de règle (ADR-030) : jour cible + décalages en
 * jours + heures. Composant client uniquement pour l'aperçu en français ("Sondage le lundi
 * à 10:00 …") recalculé à la saisie — les champs restent des inputs de formulaire natifs
 * lus par upsertRuleAction. Les noms `name` doivent rester identiques à ceux lus dans actions.ts.
 */
export function ScheduleFields(props: Props) {
  const [targetWeekday, setTargetWeekday] = useState(props.targetWeekday ?? 2);
  const [pollDaysBefore, setPollDaysBefore] = useState(props.pollDaysBefore ?? 7);
  const [pollTime, setPollTime] = useState(props.pollTime ?? "10:00");
  const [decisionDaysBefore, setDecisionDaysBefore] = useState(props.decisionDaysBefore ?? 7);
  const [decisionTime, setDecisionTime] = useState(props.decisionTime ?? "21:30");

  const pollDay = WEEKDAY_NAMES_FR[triggerWeekday(targetWeekday, pollDaysBefore)];
  const decisionDay = WEEKDAY_NAMES_FR[triggerWeekday(targetWeekday, decisionDaysBefore)];

  return (
    <fieldset>
      <legend>Planification</legend>
      <label>
        Jour de réservation visé
        <select name="targetWeekday" value={targetWeekday} onChange={(e) => setTargetWeekday(Number(e.target.value))}>
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <option key={d} value={d}>{WEEKDAY_NAMES_FR[d]}</option>
          ))}
        </select>
      </label>
      <label>
        Sondage : jours avant la date cible
        <input type="number" name="pollDaysBefore" min={1} value={pollDaysBefore} onChange={(e) => setPollDaysBefore(Number(e.target.value))} required />
      </label>
      <label>
        Sondage : heure
        <input type="time" name="pollTime" value={pollTime} onChange={(e) => setPollTime(e.target.value)} required />
      </label>
      <label>
        Décision (collecte + plan) : jours avant la date cible
        <input type="number" name="decisionDaysBefore" min={0} value={decisionDaysBefore} onChange={(e) => setDecisionDaysBefore(Number(e.target.value))} required />
      </label>
      <label>
        Décision : heure
        <input type="time" name="decisionTime" value={decisionTime} onChange={(e) => setDecisionTime(e.target.value)} required />
      </label>
      <p>
        Sondage le {pollDay} à {pollTime}, décision le {decisionDay} à {decisionTime}, pour le {WEEKDAY_NAMES_FR[targetWeekday]} suivant.
      </p>
    </fieldset>
  );
}
```

Si Next refuse d'importer `@squash-assistant/db/ruleSchedule` depuis un composant client (erreur de bundling au `npm run ui:dev`), ajouter `transpilePackages: ["@squash-assistant/db"]` dans `apps/ui/next.config.ts` ; ne répliquer les deux fonctions localement qu'en dernier recours.

- [ ] **Step 3 : `RuleForm.tsx`**

Remplacer `import { CronField } from "../components/CronField";` par `import { ScheduleFields } from "../components/ScheduleFields";`.
Remplacer les deux `<CronField … />` (lignes 115-121) par :

```tsx
        <ScheduleFields
          targetWeekday={source?.targetWeekday}
          pollDaysBefore={source?.pollDaysBefore}
          pollTime={source?.pollTime}
          decisionDaysBefore={source?.decisionDaysBefore}
          decisionTime={source?.decisionTime}
        />
```
Supprimer le `<label>Décalage jour cible …</label>` (lignes 133-136). Le libellé du jitter devient « Flou horaire du sondage auto (minutes après l'heure configurée, 0 = immédiat) ».

Supprimer `apps/ui/src/app/components/CronField.tsx` (vérifier d'abord `grep -rn CronField apps/ui/src` → seul `RuleGeneratorPanel.tsx:63` dans un commentaire, mis à jour au Step 5).

- [ ] **Step 4 : `actions.ts` — lecture + validation**

Import : `import { validateRuleSchedule } from "@squash-assistant/db/ruleSchedule";`

Remplacer les 3 lignes `pollCron / decisionCron / targetWeekdayOffset` de `values` par :

```ts
    targetWeekday: Number(formData.get("targetWeekday")),
    pollDaysBefore: Number(formData.get("pollDaysBefore")),
    pollTime: String(formData.get("pollTime") ?? "").trim(),
    decisionDaysBefore: Number(formData.get("decisionDaysBefore")),
    decisionTime: String(formData.get("decisionTime") ?? "").trim(),
```

Juste après la construction de `values` (avant `if (isNew)`) :

```ts
  const scheduleErrors = validateRuleSchedule(values);
  if (scheduleErrors.length > 0) {
    throw new Error(`Planification invalide : ${scheduleErrors.join(" ")}`);
  }
```

- [ ] **Step 5 : `RuleGeneratorPanel.tsx`**

`buildRuleFromForm` : remplacer les 3 lignes par
```ts
    targetWeekday: Number(str("targetWeekday")),
    pollDaysBefore: Number(str("pollDaysBefore")),
    pollTime: str("pollTime"),
    decisionDaysBefore: Number(str("decisionDaysBefore")),
    decisionTime: str("decisionTime"),
```
`applyParamsToForm` : remplacer les 3 `setValue(...)` par
```ts
  setValue("targetWeekday", String(params.targetWeekday));
  setValue("pollDaysBefore", String(params.pollDaysBefore));
  setValue("pollTime", params.pollTime);
  setValue("decisionDaysBefore", String(params.decisionDaysBefore));
  setValue("decisionTime", params.decisionTime);
```
`setValue` ne gère que `HTMLInputElement` : étendre le garde à `if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;` et utiliser le setter natif de `HTMLSelectElement.prototype` pour le `<select>` (même pattern que `nativeInputValueSetter`, avec `Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set`), en dispatchant un event `"change"` pour le select et `"input"` pour les inputs. Mettre à jour le commentaire ligne 63 : « les champs de planification (ScheduleFields) sont contrôlés ».

- [ ] **Step 6 : `pipelinePreview.ts`**

Supprimer `parisCalendarDate`, `computeTargetDate` et le commentaire qui les précède (plus aucun appelant : `grep -rn computeTargetDate apps/ui/src` doit ne rien renvoyer hors de ce fichier avant suppression). Garder `buildPollQuestionPreview` et ses helpers.

- [ ] **Step 7 : Vérifier**

Run: `npm run typecheck && npm test`
Expected : tout vert.

Vérification manuelle (docker-compose + `npm run worker:dev` + `npm run ui:dev`) : ouvrir `/rules/<id>/edit`, constater le bloc Planification pré-rempli avec les valeurs migrées, modifier `decisionDaysBefore` à 9 → erreur « Planification invalide : La décision (9 j avant) ne peut pas précéder le sondage (7 j avant). » ; sauvegarder une valeur valide → log worker `[scheduler] planifié « … » cible=2 poll=0 10 * * 2 (J-7) …` ; « Nouveau job » → `targetDate` = prochain mardi.

- [ ] **Step 8 : Commit**

```bash
git add apps/ui/src
git rm apps/ui/src/app/components/CronField.tsx
git commit -m "feat(ui): formulaire de règle piloté par le jour cible (ScheduleFields), validation N/M"
```

---

### Task 8 : Documentation — règles fonctionnelles, ADR-030, plan POC

**Files:**
- Modify: `docs/spec/regles-fonctionnelles.md` (lignes 24, 26, 28 + nouvelle règle + changelog)
- Create: `docs/adr/ADR-030-planification-pilotee-par-date-cible.md`
- Modify: `docs/adr/README.md` (tableau)
- Modify: `docs/plan/squash-assistant-poc.md` (section points ouverts)

- [ ] **Step 1 : `regles-fonctionnelles.md`**

Ajouter une règle (dans la section où vivent les règles 2026-08-02/04/12 sur les jobs et crons) :

```markdown
- **Planification pilotée par la date cible (2026-09-11, ADR-030)** : une règle dit **quel jour de la semaine on joue** (`BookingRule.targetWeekday`, 0 = dimanche … 6 = samedi) et **combien de jours avant** se déclenchent le sondage (`pollDaysBefore` = N, à `pollTime`) et la décision — collecte des votes + calcul du plan + attente du « go » + réservation (`decisionDaysBefore` = M, à `decisionTime`). Les jours de déclenchement sont **déduits** : jour = (jour cible − N ou M) mod 7 ; les crons ne sont plus saisis ni stockés. Invariants : N ≥ 1, 0 ≤ M ≤ N, et si M = N l'heure de décision est postérieure à l'heure du sondage (refus à la sauvegarde sinon). Une règle = un seul jour cible (mardi + samedi = deux règles). Un job créé à la main (« Nouveau job ») vise la **prochaine occurrence** du jour cible strictement après aujourd'hui (date modifiable tant que le sondage n'est pas parti). Si la règle est modifiée entre le sondage et la décision (jour cible ou M), la décision auto peut ne trouver aucun job pour sa date : elle logue sur Telegram et s'arrête, le job restant déclenchable à la main. Heures inchangées d'une semaine à l'autre : seule la date change.
```

Reformuler les mentions existantes :
- ligne 24 : « un job créé par le scheduler (cron `pollCron`, déclenchement automatique) » → « un job créé par le scheduler (déclenchement automatique du sondage) » ;
- ligne 26 : « s'applique uniquement à `pollCron` » → « s'applique uniquement au déclenchement du sondage » ; « `decisionCron` (collecte des votes + calcul du plan) se déclenche pile à l'heure configurée » → « la décision (collecte des votes + calcul du plan) se déclenche pile à `decisionTime` » ;
- ligne 28 : « `pollCron` / `decisionCron` regardent l'état du job » → « les déclenchements auto (sondage / décision) regardent l'état du job » ; « Cas `decisionCron` » → « Cas de la décision ».

Changelog (tableau en fin de fichier) :

```markdown
| 2026-09-11 | Planification pilotée par la date cible : `targetWeekday` + `pollDaysBefore`/`pollTime` + `decisionDaysBefore`/`decisionTime` remplacent `pollCron`/`decisionCron`/`targetWeekdayOffset` ; crons dérivés ; job manuel = prochaine occurrence du jour cible | La date de réservation est ce qui fait foi ; raisonner « sondage mardi + 4 jours » pour viser le samedi était illisible (ADR-030) |
```

- [ ] **Step 2 : ADR-030**

`docs/adr/ADR-030-planification-pilotee-par-date-cible.md` :

```markdown
# ADR-030 – Planification pilotée par la date cible : le jour de réservation fait foi, les crons sont dérivés

**Status:** accepted
**Date:** 2026-09-11

## Contexte

Jusqu'ici une `BookingRule` était pilotée par la date de lancement du sondage : `pollCron` et
`decisionCron` portaient le jour et l'heure des déclenchements, et `targetWeekdayOffset` disait
combien de jours *après* tombait la réservation. Le jour visé (mardi, samedi…) n'existait nulle
part explicitement — pour « réserver le samedi », il fallait raisonner à l'envers (« sondage mardi
+ 4 jours »). Le besoin exprimé le 2026-09-11 : la source de vérité doit être la date et l'heure
de réservation voulues ; le sondage et la décision sont « N / M jours avant ».

Côté resa-squash, un flag `force` est en cours d'ajout (réserver hors de l'horizon glissant de
7 jours, [resa-squash ADR-012], sans créer de planification). Il n'est pas consommé ici.

## Décision

1. **Nouveau modèle de règle** : `targetWeekday` (0 = dimanche … 6 = samedi), `pollDaysBefore`
   (N ≥ 1) + `pollTime`, `decisionDaysBefore` (M, 0 ≤ M ≤ N, indépendant de N) + `decisionTime`.
   Si M = N, `decisionTime > pollTime`. Une règle = un seul jour cible.
2. **Crons dérivés, jamais stockés** : `packages/db/src/ruleSchedule.ts::deriveCrons` calcule
   `"MM HH * * ((targetWeekday − N) mod 7)"` ; `cronRegistry` l'appelle à chaque (re)planification.
   `computeTargetDate(now, N | M)` est inchangé — sondage et décision retombent sur la même
   `targetDate`, donc sur le même job, même quand N ≠ M.
3. **Job manuel** : `targetDate` = prochaine occurrence du jour cible strictement après
   aujourd'hui (`weekKey.ts::nextWeekdayDate`).
4. **Migration 0024 avec conversion SQL** des règles existantes (`target_weekday = (jour_poll +
   offset) % 7`, `poll_days_before = offset`, `decision_days_before = offset − ((jour_dec −
   jour_poll + 7) % 7)`), puis suppression des trois anciennes colonnes. Sentinelles
   `0 0 1 1 *` → valeurs neutres, règle désactivée.
5. **Validation** partagée (`validateRuleSchedule`) appelée par l'action serveur de l'UI, seul
   point d'écriture des règles.

## Conséquences

- L'UI, l'extraction LLM (`ruleParamsExtraction`) et la description en français
  (`describeRuleInFrench`) parlent en « jour cible + jours avant + heures », plus en crons ;
  `CronField.tsx` est supprimé.
- Le rappel J+1 (`nextDayReminderEnabled`) reste ancré sur `JobRun.createdAt`, pas sur la cible.
- Le jitter et l'idempotence des déclenchements auto ne changent pas.
- **Suite prévue — flag `force`** : la décision (et donc la réservation) a lieu M jours avant
  la cible. `M ≤ 7` : dans l'horizon resa-squash, rien à faire. `M > 7` : hors horizon → il faudra
  passer `force: true` à resa-squash, sinon une planification est créée au lieu d'une
  réservation. Dériver `force` de `M > 7` ou exposer `BookingRule.forceBooking` : à trancher dans
  une itération dédiée ; dans celle-ci l'appel MCP est inchangé (flag absent = `false`).
```

`docs/adr/README.md` — ajouter la ligne :
```markdown
| [030](./ADR-030-planification-pilotee-par-date-cible.md) | Planification pilotée par la date cible : `targetWeekday` + décalages N/M + heures, crons dérivés, migration avec conversion des règles | accepted |
```

- [ ] **Step 3 : Plan POC — point ouvert**

Dans `docs/plan/squash-assistant-poc.md`, section « Points ouverts » (repérer avec `grep -n "Points ouverts\|points ouverts" docs/plan/squash-assistant-poc.md`), ajouter :

```markdown
- **Flag `force` resa-squash (après ADR-030)** : nécessaire dès que `decisionDaysBefore` (M) > 7 (réservation demandée hors de l'horizon glissant de 7 jours). Choix à faire : dériver `force = M > 7` automatiquement, ou champ `BookingRule.forceBooking`. Tant que non tranché, l'appel MCP reste sans flag (= `false`).
```

- [ ] **Step 4 : Commit**

```bash
git add docs/spec/regles-fonctionnelles.md docs/adr/ADR-030-planification-pilotee-par-date-cible.md docs/adr/README.md docs/plan/squash-assistant-poc.md docs/superpowers
git commit -m "docs: ADR-030 et règles fonctionnelles — planification pilotée par la date cible"
```

---

### Task 9 : Vérification finale et graphe de connaissance

**Files:** aucun nouveau.

- [ ] **Step 1 : Suite complète**

Run: `npm run typecheck && npm test`
Expected : tout vert (packages/db, apps/worker, apps/ui, apps/listener).

- [ ] **Step 2 : Test LLM réel (si `ANTHROPIC_API_KEY` disponible)**

Run: `npm run test:llm -w apps/worker`
Expected : les 3 règles réelles sont retrouvées (round-trip description → extraction) avec les 5 nouveaux champs. Si la clé manque, l'indiquer explicitement dans le compte-rendu — ne pas prétendre que c'est passé.

- [ ] **Step 3 : Grep de non-régression**

Run: `grep -rn "pollCron\|decisionCron\|targetWeekdayOffset" apps packages docs/spec --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md' | grep -v node_modules | grep -v dist/ | grep -v graphify-out`
Expected : aucune occurrence, sauf le SQL de migration 0024 et l'ADR-030 / changelog (mentions historiques volontaires).

- [ ] **Step 4 : Graphe**

Run: `graphify update .`

- [ ] **Step 5 : Commit (si le grep a demandé des retouches)**

```bash
git add -A apps packages docs
git commit -m "chore: retouches ADR-030 après vérification finale"
```
