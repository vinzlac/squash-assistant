import { headers } from "next/headers";

export interface AuthentikUser {
  username: string | null;
  email: string | null;
  name: string | null;
  groups: string[];
}

/**
 * Identité de l'utilisateur courant, injectée par l'Outpost Authentik
 * (ForwardAuth Traefik, headers X-authentik-*) — jamais lue depuis une source
 * cliente (query param/body), l'auth est entièrement hors du code app. `null`
 * si les headers sont absents (ex. accès direct au worker en dev local, hors
 * du reverse proxy) — cas anormal derrière Authentik en prod.
 */
export async function getAuthentikUser(): Promise<AuthentikUser | null> {
  const h = await headers();
  const username = h.get("x-authentik-username");
  const email = h.get("x-authentik-email");
  if (!username && !email) return null;

  const name = h.get("x-authentik-name");
  const groupsHeader = h.get("x-authentik-groups") ?? "";
  const groups = groupsHeader
    .split("|")
    .map((g) => g.trim())
    .filter(Boolean);

  return { username, email, name, groups };
}
