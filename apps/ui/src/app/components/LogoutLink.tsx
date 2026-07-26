"use client";

/**
 * Le host courant (LAN vs public) n'est fiable côté client qu'via
 * window.location.origin — voir brief Authentik : sign_out et rd doivent
 * pointer vers l'origine sur laquelle l'utilisateur est réellement.
 */
export function LogoutLink() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const logoutUrl = `${origin}/outpost.goauthentik.io/sign_out?rd=${encodeURIComponent(`${origin}/`)}`;
  return <a href={logoutUrl}>Déconnexion</a>;
}
