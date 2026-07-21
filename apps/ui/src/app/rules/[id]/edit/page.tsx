import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
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

  return (
    <main>
      <h1>Éditer « {rule.id} »</h1>
      <RuleForm
        rule={rule}
        whatsappGroupName={whatsappGroupName}
        resaSquashGroupName={resaSquashGroupName}
        groupMemberNames={groupMemberNames}
      />
    </main>
  );
}
