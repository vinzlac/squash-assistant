import { randomUUID } from "node:crypto";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../../../lib/db";
import { getGroupMemberNames } from "../../../lib/worker";
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
  // Groupe resa-squash connu seulement en duplication (sinon resaSquashGroupId n'est pas encore
  // saisi) — même groupe la plupart du temps qu'on duplique une règle existante.
  const groupMemberNames = cloneFrom ? await getGroupMemberNames(cloneFrom).catch(() => ({}) as Record<string, string>) : {};

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
      <RuleForm
        whatsappGroupJid={groupJid}
        cloneFromRule={cloneFromRule}
        groupMemberNames={groupMemberNames}
        generatedId={randomUUID()}
      />
    </main>
  );
}
