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
