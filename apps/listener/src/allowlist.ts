import { eq } from "drizzle-orm";
import type { Database } from "@squash-assistant/db/client";
import { bookingRules } from "@squash-assistant/db/schema";

export function buildAllowlist(jids: string[], vincentAllGroupJid: string): Set<string> {
  return new Set(jids.filter((j) => j !== vincentAllGroupJid));
}

export async function loadAllowlist(db: Database, vincentAllGroupJid: string): Promise<Set<string>> {
  const rows = await db
    .select({ whatsappGroupJid: bookingRules.whatsappGroupJid })
    .from(bookingRules)
    .where(eq(bookingRules.enabled, true));
  return buildAllowlist(
    rows.map((r) => r.whatsappGroupJid),
    vincentAllGroupJid,
  );
}
