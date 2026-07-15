import { eq, sql } from "drizzle-orm";
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

/**
 * "Nouveau job" : incrémente runToken pour repartir sur un thread LangGraph
 * vierge sans attendre la semaine calendaire suivante (thread_id inclut
 * runToken — cf. threadIdFor dans scheduler.ts). Utile en mode manuel pour
 * rejouer le pipeline après une erreur ou pour retester plusieurs fois la
 * même semaine.
 */
export async function incrementRunToken(db: Database, id: string): Promise<BookingRule | undefined> {
  const [rule] = await db
    .update(bookingRulesTable)
    .set({ runToken: sql`${bookingRulesTable.runToken} + 1` })
    .where(eq(bookingRulesTable.id, id))
    .returning();
  return rule;
}
