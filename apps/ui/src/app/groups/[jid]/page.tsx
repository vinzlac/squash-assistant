import Link from "next/link";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../../../lib/db";
import { listHuddleBotGroups } from "../../../lib/huddleBot";
import { deleteRuleAction, toggleRuleEnabledAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function GroupPage({ params }: { params: Promise<{ jid: string }> }) {
  const { jid: rawJid } = await params;
  const jid = decodeURIComponent(rawJid);

  const [rules, groups] = await Promise.all([
    getDb().select().from(bookingRules).where(eq(bookingRules.whatsappGroupJid, jid)),
    listHuddleBotGroups().catch(() => null),
  ]);

  const group = groups?.find((g) => g.jid === jid);

  return (
    <main>
      <p>
        <Link href="/">← Retour</Link>
      </p>
      <h1>{group?.name ?? jid}</h1>
      <p className="muted">{jid}</p>

      <h2>Règles de réservation</h2>
      <Link href={`/rules/new?groupJid=${encodeURIComponent(jid)}`} className="button button-primary">
        + Nouvelle règle pour ce groupe
      </Link>

      <table style={{ marginTop: "1rem" }}>
        <thead>
          <tr>
            <th>Statut</th>
            <th>Règle</th>
            <th>Sondage</th>
            <th>Décision</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id}>
              <td>
                <span className={`badge ${rule.enabled ? "badge-on" : "badge-off"}`}>
                  {rule.enabled ? "actif" : "inactif"}
                </span>
              </td>
              <td>{rule.id}</td>
              <td className="muted">{rule.pollCron}</td>
              <td className="muted">{rule.decisionCron}</td>
              <td>
                <form action={toggleRuleEnabledAction} className="inline">
                  <input type="hidden" name="id" value={rule.id} />
                  <input type="hidden" name="enabled" value={(!rule.enabled).toString()} />
                  <button type="submit">{rule.enabled ? "Désactiver" : "Activer"}</button>
                </form>{" "}
                <Link href={`/rules/${rule.id}/edit`} className="button">
                  Éditer
                </Link>{" "}
                <Link href={`/rules/${rule.id}/events`} className="button">
                  Historique
                </Link>{" "}
                <form action={deleteRuleAction} className="inline">
                  <input type="hidden" name="id" value={rule.id} />
                  <button type="submit">Supprimer</button>
                </form>
              </td>
            </tr>
          ))}
          {rules.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Aucune règle pour ce groupe pour l'instant.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
