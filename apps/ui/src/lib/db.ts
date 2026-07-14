import { createDbClient, type Database } from "@squash-assistant/db/client";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

// Initialisation paresseuse : Next.js évalue les modules des pages au build
// (collecte des métadonnées de routes) sans les vraies variables d'env —
// une connexion créée au chargement du module ferait échouer le build.
let dbInstance: Database | undefined;

export function getDb(): Database {
  if (!dbInstance) {
    dbInstance = createDbClient(requireEnv("DATABASE_URL"));
  }
  return dbInstance;
}
