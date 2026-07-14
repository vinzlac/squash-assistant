import Link from "next/link";
import { RuleForm } from "../RuleForm";

export default async function NewRulePage({
  searchParams,
}: {
  searchParams: Promise<{ groupJid?: string }>;
}) {
  const { groupJid } = await searchParams;

  return (
    <main>
      {groupJid && (
        <p>
          <Link href={`/groups/${encodeURIComponent(groupJid)}`}>← Retour au groupe</Link>
        </p>
      )}
      <h1>Nouvelle règle de réservation</h1>
      <RuleForm whatsappGroupJid={groupJid} />
    </main>
  );
}
