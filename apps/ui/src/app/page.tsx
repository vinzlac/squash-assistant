import Link from "next/link";
import { bookingRules, type BookingRule } from "@squash-assistant/db/schema";
import { getDb } from "../lib/db";
import { listHuddleBotGroups, type HuddleBotGroup } from "../lib/huddleBot";
import { deleteRuleAction, toggleRuleEnabledAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [rules, groups] = await Promise.all([
    getDb().select().from(bookingRules),
    listHuddleBotGroups().catch(() => null),
  ]);

  const rulesByGroupJid = new Map<string, BookingRule[]>();
  for (const rule of rules) {
    const existing = rulesByGroupJid.get(rule.whatsappGroupJid) ?? [];
    rulesByGroupJid.set(rule.whatsappGroupJid, [...existing, rule]);
  }

  return (
    <main>
      <h1>squash-assistant</h1>
      <p className="muted">Administration des règles de réservation.</p>

      <h2>Groupes WhatsApp</h2>
      {groups === null && (
        <p className="muted">huddle-bot indisponible — impossible de lister les groupes WhatsApp pour l'instant.</p>
      )}
      {groups !== null && groups.length === 0 && <p className="muted">Aucun groupe trouvé.</p>}
      {groups !== null && groups.filter((g) => g.isGroup).map((group: HuddleBotGroup) => (
        <div key={group.jid} className="card">
          <strong>{group.name}</strong>
          <span className="muted"> — {rulesByGroupJid.get(group.jid)?.length ?? 0} règle(s)</span>
          <div className="muted">{group.jid}</div>
        </div>
      ))}

      <h2>Règles de réservation</h2>
      <Link href="/rules/new" className="button button-primary">
        + Nouvelle règle
      </Link>
      <table style={{ marginTop: "1rem" }}>
        <thead>
          <tr>
            <th>Statut</th>
            <th>Règle</th>
            <th>Groupe WhatsApp</th>
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
              <td className="muted">{rule.whatsappGroupJid}</td>
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
                <form action={deleteRuleAction} className="inline">
                  <input type="hidden" name="id" value={rule.id} />
                  <button type="submit">Supprimer</button>
                </form>
              </td>
            </tr>
          ))}
          {rules.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                Aucune règle pour l'instant.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
