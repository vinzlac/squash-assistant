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
