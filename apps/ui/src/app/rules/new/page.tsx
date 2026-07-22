import Link from "next/link";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../../../lib/db";
import { RuleForm } from "../RuleForm";

export default async function NewRulePage({
  searchParams,
}: {
  searchParams: Promise<{ groupJid?: string; cloneFrom?: string }>;
}) {
  const { groupJid, cloneFrom } = await searchParams;

  const cloneFromRule = cloneFrom
    ? (await getDb().select().from(bookingRules).where(eq(bookingRules.id, cloneFrom)))[0]
    : undefined;

  return (
    <main>
      {groupJid && (
        <p>
          <Link href={`/groups/${encodeURIComponent(groupJid)}`}>← Retour au groupe</Link>
        </p>
      )}
      <h1>
        Nouvelle règle de réservation
        {cloneFromRule && ` (dupliquée depuis « ${cloneFromRule.name ?? cloneFromRule.id} »)`}
      </h1>
      <RuleForm whatsappGroupJid={groupJid} cloneFromRule={cloneFromRule} />
    </main>
  );
}
