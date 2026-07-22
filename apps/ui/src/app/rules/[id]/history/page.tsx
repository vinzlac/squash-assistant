import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { bookingRuleHistory, bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";

export default async function RuleHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();

  const [rule] = await db.select().from(bookingRules).where(eq(bookingRules.id, id));
  if (!rule) {
    notFound();
  }

  const history = await db
    .select()
    .from(bookingRuleHistory)
    .where(eq(bookingRuleHistory.bookingRuleId, id))
    .orderBy(desc(bookingRuleHistory.changedAt));

  return (
    <main>
      <p>
        <Link href={`/rules/${id}/edit`}>← Retour à la règle</Link>
      </p>
      <h1>Historique de la règle « {rule.name ?? rule.id} »</h1>
      <p className="muted">
        Chaque sauvegarde (création, édition, activation/désactivation) enregistre une copie complète de la règle à
        cet instant — indépendant des snapshots par job (ADR-014).
      </p>

      <table style={{ marginTop: "1rem" }}>
        <thead>
          <tr>
            <th>Modifiée le</th>
            <th>Nom</th>
            <th>Activée</th>
            <th>Détail</th>
          </tr>
        </thead>
        <tbody>
          {history.map((entry) => (
            <tr key={entry.id}>
              <td className="muted">{entry.changedAt.toLocaleString("fr-FR")}</td>
              <td>{entry.snapshot.name ?? "—"}</td>
              <td>
                <span className={`badge ${entry.snapshot.enabled ? "badge-on" : "badge-off"}`}>
                  {entry.snapshot.enabled ? "oui" : "non"}
                </span>
              </td>
              <td>
                <details>
                  <summary className="muted">voir</summary>
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem" }}>
                    {JSON.stringify(entry.snapshot, null, 2)}
                  </pre>
                </details>
              </td>
            </tr>
          ))}
          {history.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                Aucun historique enregistré pour l'instant — sera rempli à la prochaine sauvegarde de cette règle.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
