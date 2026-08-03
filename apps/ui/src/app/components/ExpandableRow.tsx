"use client";

import { useState, type ReactNode } from "react";

/** Ligne de table entière cliquable pour déplier/replier un détail (remplace un lien "voir" dédié). */
export function ExpandableRow({
  children,
  detail,
  colSpan,
}: {
  children: ReactNode;
  detail: ReactNode;
  colSpan: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr onClick={() => setOpen((o) => !o)} style={{ cursor: "pointer" }}>
        {children}
      </tr>
      {open && (
        <tr>
          <td colSpan={colSpan}>{detail}</td>
        </tr>
      )}
    </>
  );
}
