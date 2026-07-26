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
 * Combo (menu déroulant) pour ajouter un membre du groupe resa-squash sans devoir connaître/copier
 * son userId, plus une liste des personnes déjà sélectionnées (nom + userId) mise à jour en direct,
 * avec un bouton pour retirer. Écrit dans le champ texte CSV existant (non contrôlé), qui reste la
 * source de vérité soumise au formulaire. Ordre = ordre d'ajout (priorité) ; une suppression retire
 * uniquement cette personne sans réordonner le reste.
 */
export function MemberPicker({ groupMemberNames, targetFieldName, initialSelected }: Props) {
  const [selected, setSelected] = useState<string[]>(initialSelected);

  const entries = Object.entries(groupMemberNames).sort((a, b) => a[1].localeCompare(b[1]));
  if (entries.length === 0) return null;

  const availableEntries = entries.filter(([userId]) => !selected.includes(userId));

  function sync(next: string[], form: HTMLFormElement | null) {
    const input = form?.elements.namedItem(targetFieldName);
    if (input instanceof HTMLInputElement) input.value = next.join(", ");
    setSelected(next);
  }

  return (
    <div style={{ gridColumn: "1 / -1" }}>
      <select
        value=""
        onChange={(e) => {
          const userId = e.currentTarget.value;
          const form = e.currentTarget.form;
          e.currentTarget.value = "";
          if (!userId || selected.includes(userId)) return;
          sync([...selected, userId], form);
        }}
      >
        <option value="" disabled>
          + Ajouter depuis les membres du groupe…
        </option>
        {availableEntries.map(([userId, name]) => (
          <option key={userId} value={userId}>
            {name} ({userId})
          </option>
        ))}
      </select>
      {selected.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "0.5rem 0 0" }}>
          {selected.map((userId) => (
            <li key={userId}>
              {groupMemberNames[userId] ?? "?"} <span className="muted">({userId})</span>{" "}
              <button
                type="button"
                onClick={(e) => sync(selected.filter((id) => id !== userId), e.currentTarget.form)}
              >
                Retirer
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
