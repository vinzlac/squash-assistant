"use client";

import { useState } from "react";
import { SubmitButton } from "./SubmitButton";

type Props = {
  action: (formData: FormData) => void | Promise<void>;
  disabled?: boolean;
};

/**
 * Formulaire d'ajout de fermeture PUC : mode « toute la journée » (dates seules)
 * ou horaires précis (datetime-local), comme GoConfirmationForm (state contrôlé).
 */
export function ClubClosureAddForm({ action, disabled = false }: Props) {
  const [allDay, setAllDay] = useState(true);

  return (
    <form action={action}>
      <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: "1rem 0 0" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <input
            type="checkbox"
            name="allDay"
            value="on"
            checked={allDay}
            onChange={(e) => setAllDay(e.target.checked)}
          />
          Toute la journée
          <span className="muted">(une ou plusieurs dates civiles, sans choisir l&apos;heure)</span>
        </label>

        <div className="form-grid">
          {allDay ? (
            <>
              <label>
                Du
                <input type="date" name="startDate" required />
              </label>
              <label>
                Au
                <input type="date" name="endDate" required />
              </label>
            </>
          ) : (
            <>
              <label>
                Début
                <input type="datetime-local" name="startsAt" required />
              </label>
              <label>
                Fin
                <input type="datetime-local" name="endsAt" required />
              </label>
            </>
          )}
          <label>
            Libellé
            <input type="text" name="label" placeholder="15 août, vacances…" />
          </label>
        </div>
        <div className="form-actions">
          <SubmitButton className="button-primary">Ajouter</SubmitButton>
        </div>
      </fieldset>
    </form>
  );
}
