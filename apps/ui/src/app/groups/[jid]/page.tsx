import Link from "next/link";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../../../lib/db";
import { listHuddleBotGroups } from "../../../lib/huddleBot";
import { deleteRuleAction, toggleRuleEnabledAction } from "../../actions";
import { isAdmin } from "../../../lib/authz";

export const dynamic = "force-dynamic";

export default async function GroupPage({ params }: { params: Promise<{ jid: string }> }) {
  const { jid: rawJid } = await params;
  const jid = decodeURIComponent(rawJid);

  const [rules, groups, admin] = await Promise.all([
    getDb().select().from(bookingRules).where(eq(bookingRules.whatsappGroupJid, jid)),
    listHuddleBotGroups().catch(() => null),
    isAdmin(),
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
      {admin && (
        <Link href={`/rules/new?groupJid=${encodeURIComponent(jid)}`} className="button button-primary">
          + Nouvelle règle pour ce groupe
        </Link>
      )}

      <div className="table-scroll" style={{ marginTop: "1rem" }}>
        <table>
          <thead>
            <tr>
              <th>Statut</th>
              <th>Règle</th>
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
                <td>
                  <Link href={`/rules/${rule.id}/edit`}>{rule.name ?? rule.id}</Link>
                  {rule.name && <div className="muted">{rule.id}</div>}
                </td>
                <td className="actions-cell">
                  <form action={toggleRuleEnabledAction} className="inline">
                    <input type="hidden" name="id" value={rule.id} />
                    <input type="hidden" name="enabled" value={(!rule.enabled).toString()} />
                    <button
                      type="submit"
                      className="icon-button"
                      title={rule.enabled ? "Désactiver" : "Activer"}
                      aria-label={rule.enabled ? "Désactiver" : "Activer"}
                      disabled={!admin}
                    >
                      {rule.enabled ? "⏸" : "▶"}
                    </button>
                  </form>
                  <Link href={`/rules/${rule.id}/events`} className="button icon-button" title="Jobs" aria-label="Jobs">
                    📋
                  </Link>
                  {admin && (
                    <Link
                      href={`/rules/new?groupJid=${encodeURIComponent(jid)}&cloneFrom=${rule.id}`}
                      className="button icon-button"
                      title="Dupliquer"
                      aria-label="Dupliquer"
                    >
                      ⧉
                    </Link>
                  )}
                  {admin && (
                    <form action={deleteRuleAction} className="inline">
                      <input type="hidden" name="id" value={rule.id} />
                      <button type="submit" className="icon-button" title="Supprimer" aria-label="Supprimer">
                        🗑
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  Aucune règle pour ce groupe pour l'instant.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
