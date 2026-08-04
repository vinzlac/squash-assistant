import Link from "next/link";
import { bookingRules, type BookingRule } from "@squash-assistant/db/schema";
import { getDb } from "../lib/db";
import { listHuddleBotGroups, type HuddleBotGroup } from "../lib/huddleBot";
import { getVisibleWhatsappGroupJids } from "../lib/settings";
import { isAdmin } from "../lib/authz";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [rules, groups, visibleJids, admin] = await Promise.all([
    getDb().select().from(bookingRules),
    listHuddleBotGroups().catch(() => null),
    getVisibleWhatsappGroupJids(),
    isAdmin(),
  ]);

  const rulesByGroupJid = new Map<string, BookingRule[]>();
  for (const rule of rules) {
    const existing = rulesByGroupJid.get(rule.whatsappGroupJid) ?? [];
    rulesByGroupJid.set(rule.whatsappGroupJid, [...existing, rule]);
  }

  const visibleGroups = groups
    ?.filter((g) => g.isGroup)
    .filter((g) => visibleJids === null || visibleJids.includes(g.jid));

  return (
    <main>
      <h1 className="brand-title">
        <img src="/squash-emblem.svg" alt="" width={32} height={32} />
        squash-assistant
      </h1>
      <p className="muted">Administration des règles de réservation.</p>

      <h2>
        Groupes WhatsApp{" "}
        {admin && (
          <>
            <Link href="/settings" className="icon-button" title="Paramètres — choisir les groupes affichés" aria-label="Paramètres">
              ⚙
            </Link>{" "}
            <Link href="/listener" className="muted" style={{ fontSize: "0.9rem", marginLeft: "0.5rem" }}>
              Listener
            </Link>
          </>
        )}
      </h2>
      {groups === null && (
        <p className="muted">huddle-bot indisponible — impossible de lister les groupes WhatsApp pour l'instant.</p>
      )}
      {visibleGroups !== undefined && visibleGroups.length === 0 && (
        <p className="muted">
          {admin ? (
            <>
              Aucun groupe à afficher — {groups?.length ?? 0} groupe(s) WhatsApp au total, réglable dans{" "}
              <Link href="/settings">Paramètres</Link>.
            </>
          ) : (
            "Aucun groupe à afficher."
          )}
        </p>
      )}
      {visibleGroups?.map((group: HuddleBotGroup) => (
        <Link key={group.jid} href={`/groups/${encodeURIComponent(group.jid)}`} className="card">
          <strong>{group.name}</strong>
          <span className="muted"> — {rulesByGroupJid.get(group.jid)?.length ?? 0} règle(s)</span>
          <div className="muted">{group.jid}</div>
        </Link>
      ))}
    </main>
  );
}
