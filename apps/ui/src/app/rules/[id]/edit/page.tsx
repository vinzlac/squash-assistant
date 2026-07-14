import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../../../../lib/db";
import { RuleForm } from "../../RuleForm";

export default async function EditRulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [rule] = await getDb().select().from(bookingRules).where(eq(bookingRules.id, id));

  if (!rule) {
    notFound();
  }

  return (
    <main>
      <h1>Éditer « {rule.id} »</h1>
      <RuleForm rule={rule} />
    </main>
  );
}
