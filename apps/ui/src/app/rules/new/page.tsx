import { randomUUID } from "node:crypto";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../../../lib/db";
import { listHuddleBotGroups } from "../../../lib/huddleBot";
import { getFavoriteNames, getGroupMemberNames } from "../../../lib/worker";
import { isAdmin } from "../../../lib/authz";
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
  const [groupMemberNames, favoriteNames, whatsappGroups, admin] = await Promise.all([
    cloneFrom ? getGroupMemberNames(cloneFrom).catch(() => ({}) as Record<string, string>) : Promise.resolve({}),
    // Favoris du compte : indépendants de la règle, donc disponibles dès la création (ADR-024).
    getFavoriteNames().catch(() => ({}) as Record<string, string>),
    listHuddleBotGroups().catch(() => [] as Awaited<ReturnType<typeof listHuddleBotGroups>>),
    isAdmin(),
  ]);
  const whatsappGroupName = groupJid ? whatsappGroups.find((g) => g.jid === groupJid)?.name : undefined;

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
      {!admin && <p className="muted">Lecture seule — réservé aux administrateurs (groupe Authentik "squash-admins").</p>}
      <RuleForm
        whatsappGroupJid={groupJid}
        whatsappGroupName={whatsappGroupName}
        cloneFromRule={cloneFromRule}
        groupMemberNames={groupMemberNames}
        favoriteNames={favoriteNames}
        whatsappGroups={whatsappGroups}
        generatedId={randomUUID()}
        readOnly={!admin}
      />
    </main>
  );
}
