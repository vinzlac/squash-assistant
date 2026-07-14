import type { Database } from "@squash-assistant/db/client";
import { bookingRules as bookingRulesTable, type BookingRule } from "@squash-assistant/db/schema";

export async function loadBookingRules(db: Database): Promise<BookingRule[]> {
  return db.select().from(bookingRulesTable);
}
