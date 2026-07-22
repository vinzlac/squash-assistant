import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
import { describeRuleInFrench } from "@squash-assistant/db/ruleDescription";
import { getDb } from "../../../../lib/db";
import { listHuddleBotGroups } from "../../../../lib/huddleBot";
import { listResaSquashGroups } from "../../../../lib/resaSquash";
import { getGroupMemberNames } from "../../../../lib/worker";
import { RuleForm } from "../../RuleForm";

export default async function EditRulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [rule] = await getDb().select().from(bookingRules).where(eq(bookingRules.id, id));

  if (!rule) {
    notFound();
  }

  const [whatsappGroups, resaSquashGroups, groupMemberNames] = await Promise.all([
    listHuddleBotGroups().catch(() => null),
    listResaSquashGroups().catch(() => null),
    getGroupMemberNames(id).catch(() => ({}) as Record<string, string>),
  ]);
  const whatsappGroupName = whatsappGroups?.find((g) => g.jid === rule.whatsappGroupJid)?.name;
  const resaSquashGroupName = resaSquashGroups?.find((g) => g.groupId === rule.resaSquashGroupId)?.label;
  // Mise en cache (actions.ts, refreshRuleDescription) à chaque sauvegarde — repli sur un calcul à
  // la volée seulement pour une règle jamais resauvegardée depuis l'ajout de cette colonne.
  const description =
    rule.description ?? describeRuleInFrench(rule, { whatsappGroupName, resaSquashGroupName, playerNames: groupMemberNames });

  return (
    <main>
      <p>
        <Link href={`/groups/${encodeURIComponent(rule.whatsappGroupJid)}`}>← Retour au groupe</Link>
        {" · "}
        <Link href={`/rules/new?groupJid=${encodeURIComponent(rule.whatsappGroupJid)}`}>
          + Nouvelle règle pour ce groupe
        </Link>
        {" · "}
        <Link href={`/rules/new?groupJid=${encodeURIComponent(rule.whatsappGroupJid)}&cloneFrom=${rule.id}`}>
          Dupliquer
        </Link>
        {" · "}
        <Link href={`/rules/${rule.id}/events`}>Historique des jobs</Link>
        {" · "}
        <Link href={`/rules/${rule.id}/history`}>Historique de la règle</Link>
      </p>
      <h1>Éditer « {rule.name ?? rule.id} »</h1>

      <details style={{ marginBottom: "1.5rem" }}>
        <summary className="muted">Description détaillée (générée automatiquement)</summary>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.9rem" }}>{description}</pre>
      </details>

      <RuleForm
        rule={rule}
        whatsappGroupName={whatsappGroupName}
        resaSquashGroupName={resaSquashGroupName}
        groupMemberNames={groupMemberNames}
        createdAt={rule.createdAt}
        updatedAt={rule.updatedAt}
      />
    </main>
  );
}
