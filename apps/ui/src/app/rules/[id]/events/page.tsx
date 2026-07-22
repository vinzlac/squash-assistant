import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { bookingRules, events } from "@squash-assistant/db/schema";
import { getDb } from "../../../../lib/db";
import { listJobs } from "../../../../lib/worker";
import { createJobAction } from "../../../actions";

export const dynamic = "force-dynamic";

const STAGE_LABELS: Record<string, string> = {
  "not-started": "pas démarré",
  "awaiting-decision": "attend la collecte des votes",
  "awaiting-plan": "attend le calcul du plan",
  "awaiting-go": "attend le go",
  error: "erreur",
  "finished-no-plan": "terminé (aucun créneau)",
  "finished-announced": "terminé (annoncé)",
  "finished-cancelled": "terminé (pas de go)",
};

export default async function RuleEventsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();

  const [rule] = await db.select().from(bookingRules).where(eq(bookingRules.id, id));
  if (!rule) {
    notFound();
  }

  const [ruleEvents, jobs] = await Promise.all([
    db.select().from(events).where(eq(events.bookingRuleId, id)).orderBy(desc(events.createdAt)).limit(100),
    listJobs(id).catch(() => null),
  ]);

  return (
    <main>
      <p>
        <Link href="/">← Retour</Link>
        {" · "}
        <Link href={`/rules/${rule.id}/edit`}>Éditer la règle</Link>
      </p>
      <h1>Historique « {rule.name ?? rule.id} »</h1>

      <h2>Jobs</h2>
      <form action={createJobAction} style={{ marginBottom: "1rem" }}>
        <input type="hidden" name="ruleId" value={rule.id} />
        <button type="submit" className="button-primary">
          Nouveau job
        </button>
      </form>

      {jobs === null && <p className="muted">Worker indisponible — impossible d'afficher les jobs pour l'instant.</p>}

      {jobs !== null && (
        <table style={{ marginBottom: "2rem" }}>
          <thead>
            <tr>
              <th>Créé le</th>
              <th>Date cible</th>
              <th>Étape</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map(({ job, status }) => (
              <tr key={job.id}>
                <td className="muted">{new Date(job.createdAt).toLocaleString("fr-FR")}</td>
                <td>{job.targetDate}</td>
                <td>
                  <span className={`badge ${job.cancelledAt || status.stage === "error" ? "badge-off" : "badge-on"}`}>
                    {job.cancelledAt ? "annulé" : (STAGE_LABELS[status.stage] ?? status.stage)}
                  </span>
                </td>
                <td>
                  <Link href={`/rules/${rule.id}/jobs/${job.id}`}>Voir</Link>
                </td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Aucun job pour l'instant.
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
