import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Variable d'environnement manquante : DATABASE_URL");
  }
  return url;
}

async function main(): Promise<void> {
  console.log("[migrate] Connexion à la base...");
  const client = postgres(requireDatabaseUrl(), { max: 1 });
  const db = drizzle(client);

  console.log("[migrate] Application des migrations...");
  await migrate(db, { migrationsFolder: join(__dirname, "migrations") });

  console.log("[migrate] Terminé.");
  await client.end();
}

main().catch((err) => {
  console.error("[migrate] Échec :", err);
  process.exit(1);
});
