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

/** Ensemble des règles verrouillées (référencées par au moins un scénario) — une seule requête pour la liste des règles (page.tsx), évite un ruleHasScenarios par règle. */
export async function listRuleIdsWithScenarios(): Promise<Set<string>> {
  const rows = await getDb().selectDistinct({ bookingRuleId: scenarios.bookingRuleId }).from(scenarios);
  return new Set(rows.map((r) => r.bookingRuleId));
}
