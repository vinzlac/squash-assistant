"use client";

import { useEffect, useRef, useState } from "react";
import { LogoutLink } from "./LogoutLink";

interface Props {
  displayName: string;
  profileUrl: string;
  passwordUrl: string;
}

/** Icône profil + sous-menu déroulant (Profil, Changer le mot de passe, Déconnexion) — remplace les liens texte affichés en permanence. */
export function UserMenuDropdown({ displayName, profileUrl, passwordUrl }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const initial = displayName.trim().charAt(0).toUpperCase() || "?";

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onClickOutside);
    return () => document.removeEventListener("click", onClickOutside);
  }, [open]);

  return (
    <div className="user-menu-dropdown" ref={rootRef}>
      <button
        type="button"
        className="user-menu-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        title={displayName}
      >
        {initial}
      </button>
      {open && (
        <div className="user-menu-panel">
          <div className="user-menu-panel-name">{displayName}</div>
          <a href={profileUrl}>Profil</a>
          <a href={passwordUrl}>Changer le mot de passe</a>
          <LogoutLink />
        </div>
      )}
    </div>
  );
}
