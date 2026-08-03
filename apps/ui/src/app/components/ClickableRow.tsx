"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

/** Ligne de table entière cliquable (navigation) — remplace une colonne "Voir" dédiée. */
export function ClickableRow({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <tr onClick={() => router.push(href)} style={{ cursor: "pointer" }}>
      {children}
    </tr>
  );
}
