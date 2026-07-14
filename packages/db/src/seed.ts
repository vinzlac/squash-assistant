import { readFile } from "node:fs/promises";
import { createDbClient } from "./client.js";
import { bookingRules, type BookingRule } from "./schema.js";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Variable d'environnement manquante : DATABASE_URL");
  }
  return url;
}

async function main(): Promise<void> {
  const raw = await readFile("seeds/booking-rules.seed.json", "utf-8");
  const rules = JSON.parse(raw) as BookingRule[];

  const db = createDbClient(requireDatabaseUrl());

  for (const rule of rules) {
    await db
      .insert(bookingRules)
      .values(rule)
      .onConflictDoUpdate({ target: bookingRules.id, set: rule });
    console.log(`[seed] règle "${rule.id}" upsertée.`);
  }

  console.log(`[seed] Terminé (${rules.length} règle(s)).`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed] Échec :", err);
  process.exit(1);
});
