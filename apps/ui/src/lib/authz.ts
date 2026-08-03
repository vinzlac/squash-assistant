import { getAuthentikUser } from "./authentik";

/** Groupe Authentik habilité à modifier des données — voir docs échange 2026-08-03 (squash-admins / squash-viewers créés via l'API Authentik). */
const ADMIN_GROUP = "squash-admins";

/**
 * Lève une erreur si l'utilisateur courant n'appartient pas au groupe Authentik `squash-admins`.
 * À appeler en tout premier dans toute Server Action qui modifie des données (voir actions.ts) —
 * la vérification doit vivre ici, pas seulement masquer un bouton côté UI, puisque les Server
 * Actions restent des endpoints directement appelables. Tout utilisateur authentifié qui n'est
 * pas dans squash-admins (y compris squash-viewers, ou sans groupe applicatif du tout) reste en
 * lecture seule par défaut — politique fail-safe.
 */
export async function requireAdmin(): Promise<void> {
  const user = await getAuthentikUser();
  const isAdmin = user?.groups.includes(ADMIN_GROUP) ?? false;
  if (!isAdmin) {
    throw new Error(`Action réservée aux administrateurs (groupe Authentik "${ADMIN_GROUP}").`);
  }
}
