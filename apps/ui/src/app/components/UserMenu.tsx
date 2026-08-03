import { getAuthentikUser } from "../../lib/authentik";
import { isAdmin } from "../../lib/authz";
import { UserMenuDropdown } from "./UserMenuDropdown";

const AUTHENTIK_URL = process.env.NEXT_PUBLIC_AUTHENTIK_URL ?? "https://auth.code-advisors.site";

/**
 * Barre utilisateur — lit l'identité injectée par l'Outpost Authentik
 * (headers X-authentik-*, voir lib/authentik.ts). Rien à afficher si les
 * headers sont absents (dev local hors reverse proxy) plutôt qu'une erreur :
 * l'auth reste entièrement gérée par Traefik/Authentik, pas par cette page.
 */
export async function UserMenu() {
  const user = await getAuthentikUser();
  if (!user) return null;

  const displayName = user.name || user.email || user.username || "?";
  const admin = await isAdmin();

  return (
    <div className="user-menu">
      <UserMenuDropdown
        displayName={displayName}
        role={admin ? "Administrateur" : "Lecture seule"}
        profileUrl={`${AUTHENTIK_URL}/if/flow/default-user-settings-flow/`}
        passwordUrl={`${AUTHENTIK_URL}/if/flow/default-password-change/`}
      />
    </div>
  );
}
