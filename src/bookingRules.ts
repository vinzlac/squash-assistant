import type { BookingRule } from "./config.js";
import type { Database } from "./db/client.js";
import { bookingRules as bookingRulesTable } from "./db/schema.js";

export async function loadBookingRules(db: Database): Promise<BookingRule[]> {
  return db.select().from(bookingRulesTable);
}
