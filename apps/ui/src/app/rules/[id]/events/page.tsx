import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { bookingRules, events } from "@squash-assistant/db/schema";
import { getDb } from "../../../../lib/db";
import { getWorkerRuleStatus } from "../../../../lib/worker";
import { Pipeline } from "./Pipeline";

export const dynamic = "force-dynamic";

export default async function RuleEventsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();

  const [rule] = await db.select().from(bookingRules).where(eq(bookingRules.id, id));
  if (!rule) {
    notFound();
  }

  const [ruleEvents, workerStatus] = await Promise.all([
    db.select().from(events).where(eq(events.bookingRuleId, id)).orderBy(desc(events.createdAt)).limit(100),
    getWorkerRuleStatus(id).catch(() => null),
  ]);

  return (
    <main>
      <p>
        <Link href="/">← Retour</Link>
      </p>
      <h1>Historique « {rule.id} »</h1>

      <h2>Pipeline (semaine en cours)</h2>
      {workerStatus === null && (
        <p className="muted">Worker indisponible — impossible d'afficher/déclencher le pipeline pour l'instant.</p>
      )}
      {workerStatus !== null && (
        <Pipeline
          ruleId={rule.id}
          status={workerStatus}
          targetWeekdayOffset={rule.targetWeekdayOffset}
          sessionStartTime={rule.sessionStartTime}
        />
      )}

      <h2>Événements</h2>
      <p className="muted">{ruleEvents.length} événement(s) (100 derniers max).</p>

      <table style={{ marginTop: "1rem" }}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Étape</th>
            <th>Statut</th>
            <th>Cible</th>
            <th>Détail</th>
          </tr>
        </thead>
        <tbody>
          {ruleEvents.map((event) => (
            <tr key={event.id}>
              <td className="muted">{event.createdAt.toLocaleString("fr-FR")}</td>
              <td>{event.type}</td>
              <td>
                <span className={`badge ${event.status === "success" ? "badge-on" : "badge-off"}`}>
                  {event.status}
                </span>
              </td>
              <td className="muted">{event.targetDate}</td>
              <td>
                <details>
                  <summary>voir</summary>
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem" }}>
                    {JSON.stringify(event.detail, null, 2)}
                  </pre>
                </details>
              </td>
            </tr>
          ))}
          {ruleEvents.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Aucun événement pour l'instant.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
