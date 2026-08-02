import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../../../../lib/db";
import { listScenarios } from "../../../../lib/scenarios";
import { createScenarioAction, deleteScenarioAction, duplicateScenarioAction } from "../../../actions";
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
                <form action={duplicateScenarioAction} className="inline">
                  <input type="hidden" name="bookingRuleId" value={id} />
                  <input type="hidden" name="scenarioId" value={s.id} />
                  <SubmitButton className="button">Dupliquer</SubmitButton>
                </form>{" "}
                <form action={deleteScenarioAction} className="inline">
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
