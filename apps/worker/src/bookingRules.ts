import { eq } from "drizzle-orm";
import type { Database } from "@squash-assistant/db/client";
import { bookingRules as bookingRulesTable, type BookingRule } from "@squash-assistant/db/schema";

export async function loadBookingRules(db: Database): Promise<BookingRule[]> {
  return db.select().from(bookingRulesTable);
}

/** Relit une règle depuis la DB (pas depuis un tableau chargé au démarrage, potentiellement obsolète). */
export async function getBookingRuleById(db: Database, id: string): Promise<BookingRule | undefined> {
  const [rule] = await db.select().from(bookingRulesTable).where(eq(bookingRulesTable.id, id));
  return rule;
}
