"use client";

import { useState } from "react";

interface Props {
  /** userId resa-squash → "Prénom Nom" (list_group_members) — vide si le groupe resa-squash n'est pas encore connu. */
  groupMemberNames: Record<string, string>;
  /** name du champ texte (CSV) à synchroniser — ex. "priorityBookers", "substituteBookers". */
  targetFieldName: string;
  initialSelected: string[];
}

/**
 * Coche à coche dans la liste des membres du groupe resa-squash (évite de devoir connaître/copier
 * un userId brut) — écrit directement dans le champ texte CSV existant (non contrôlé), qui reste
 * la source de vérité soumise au formulaire. Ordre de sélection préservé (priorité) : un ajout va
 * en fin de liste, une suppression retire uniquement cet id sans réordonner le reste.
 */
export function MemberPicker({ groupMemberNames, targetFieldName, initialSelected }: Props) {
  const [selected, setSelected] = useState<string[]>(initialSelected);

  const entries = Object.entries(groupMemberNames).sort((a, b) => a[1].localeCompare(b[1]));
  if (entries.length === 0) return null;

  function toggle(userId: string, checked: boolean, form: HTMLFormElement | null) {
    setSelected((prev) => {
      const next = checked ? [...prev.filter((id) => id !== userId), userId] : prev.filter((id) => id !== userId);
      const input = form?.elements.namedItem(targetFieldName);
      if (input instanceof HTMLInputElement) input.value = next.join(", ");
      return next;
    });
  }

  return (
    <details style={{ gridColumn: "1 / -1" }}>
      <summary className="muted">Choisir dans la liste des membres du groupe (évite de connaître le userId)</summary>
      <ul style={{ columns: "2", listStyle: "none", padding: 0, margin: "0.5rem 0 0" }}>
        {entries.map(([userId, name]) => (
          <li key={userId}>
            <label>
              <input
                type="checkbox"
                checked={selected.includes(userId)}
                onChange={(e) => toggle(userId, e.currentTarget.checked, e.currentTarget.form)}
              />{" "}
              {name} <span className="muted">({userId})</span>
            </label>
          </li>
        ))}
      </ul>
    </details>
  );
}
