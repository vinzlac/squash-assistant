import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
import { describeRuleInFrench } from "@squash-assistant/db/ruleDescription";
import { getDb } from "../../../../lib/db";
import { listHuddleBotGroups } from "../../../../lib/huddleBot";
import { listResaSquashGroups } from "../../../../lib/resaSquash";
import { getGroupMemberNames } from "../../../../lib/worker";
import { ruleHasScenarios } from "../../../../lib/scenarios";
import { RuleForm } from "../../RuleForm";

export default async function EditRulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [rule] = await getDb().select().from(bookingRules).where(eq(bookingRules.id, id));

  if (!rule) {
    notFound();
  }

  const locked = await ruleHasScenarios(id);

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
        <Link href={`/rules/${rule.id}/simulator`}>Simulateur de scénarios</Link>
      </p>
      <h1>Éditer « {rule.name ?? rule.id} »</h1>

      {locked && (
        <div className="pipeline-step-error" style={{ padding: "1rem", borderRadius: "8px" }}>
          <p>
            Cette règle est utilisée par au moins un scénario de simulation — supprime-le(s) d'abord pour la
            modifier (lecture seule ci-dessous).
          </p>
          <p>
            <Link href={`/rules/${id}/simulator`}>Voir les scénarios de cette règle</Link>
          </p>
        </div>
      )}
      <RuleForm
        rule={rule}
        whatsappGroupName={whatsappGroupName}
        resaSquashGroupName={resaSquashGroupName}
        groupMemberNames={groupMemberNames}
        createdAt={rule.createdAt}
        updatedAt={rule.updatedAt}
        readOnly={locked}
        description={description}
      />
    </main>
  );
}
