import { getAuthentikUser } from "../../lib/authentik";
import { LogoutLink } from "./LogoutLink";

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

  return (
    <div className="user-menu">
      <span>{displayName}</span>
      <a href={`${AUTHENTIK_URL}/if/flow/default-user-settings-flow/`}>Profil</a>
      <a href={`${AUTHENTIK_URL}/if/flow/default-password-change/`}>Changer le mot de passe</a>
      <LogoutLink />
    </div>
  );
}
