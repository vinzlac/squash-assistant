"use client";

import { useState } from "react";

export interface WhatsappGroupOption {
  jid: string;
  name: string;
}

interface Props {
  /** Groupe WhatsApp du sondage (origine) — utilisé comme valeur par défaut / libellé. */
  pollGroupJid: string;
  pollGroupName?: string;
  /** null = mode « groupe d'origine » ; sinon JID du groupe de notification choisi. */
  initialNotifyJid: string | null;
  groups: WhatsappGroupOption[];
  legend?: string;
  description?: string;
  /** Noms des champs de formulaire : uniques par instance (plusieurs champs dans le même <form>). */
  modeFieldName?: string;
  jidFieldName?: string;
}

const DEFAULT_LEGEND = "Groupe de notification des réservations";
const DEFAULT_DESCRIPTION =
  "Destinataire du message WhatsApp d'annonce (étape 4) — distinct du sondage, qui reste toujours sur le groupe d'origine.";

/**
 * Choix d'un destinataire WhatsApp : soit le groupe du sondage,
 * soit un autre groupe WhatsApp sélectionné dans la liste huddle-bot.
 * Utilisé pour l'annonce (étape 4) et pour la confirmation + QR (étape 5, ADR-035).
 */
export function ReservationNotifyGroupField({
  pollGroupJid,
  pollGroupName,
  initialNotifyJid,
  groups,
  legend = DEFAULT_LEGEND,
  description = DEFAULT_DESCRIPTION,
  modeFieldName = "reservationNotifyMode",
  jidFieldName = "reservationNotifyWhatsappGroupJid",
}: Props) {
  const initialCustom =
    initialNotifyJid != null && initialNotifyJid !== "" && initialNotifyJid !== pollGroupJid;
  const [mode, setMode] = useState<"origin" | "custom">(initialCustom ? "custom" : "origin");
  const [customJid, setCustomJid] = useState(
    initialCustom ? initialNotifyJid! : (groups.find((g) => g.jid !== pollGroupJid)?.jid ?? ""),
  );

  const pollLabel = pollGroupName ? `${pollGroupName} (${pollGroupJid})` : pollGroupJid;
  const otherGroups = groups.filter((g) => g.jid !== pollGroupJid);
  // Les radios ne doivent pas atteindre le FormData : nom distinct du champ caché, et propre à l'instance.
  const radioName = `${modeFieldName}Radio`;

  return (
    <fieldset style={{ gridColumn: "1 / -1", border: "1px solid var(--border)", borderRadius: "8px", padding: "0.75rem 1rem" }}>
      <legend style={{ padding: "0 0.25rem" }}>{legend}</legend>
      <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        {description}
      </p>
      <input type="hidden" name={modeFieldName} value={mode} />
      <label style={{ display: "block", marginBottom: "0.5rem" }}>
        <input
          type="radio"
          name={radioName}
          checked={mode === "origin"}
          onChange={() => setMode("origin")}
        />{" "}
        Groupe d&apos;origine (celui du sondage) — {pollLabel}
      </label>
      <label style={{ display: "block", marginBottom: "0.5rem" }}>
        <input
          type="radio"
          name={radioName}
          checked={mode === "custom"}
          onChange={() => setMode("custom")}
          disabled={otherGroups.length === 0}
        />{" "}
        Autre groupe WhatsApp
      </label>
      {mode === "custom" && (
        <label style={{ display: "block", marginLeft: "1.5rem" }}>
          Groupe
          <select
            name={jidFieldName}
            value={customJid}
            onChange={(e) => setCustomJid(e.target.value)}
            required
            style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
          >
            {otherGroups.length === 0 && <option value="">Aucun autre groupe disponible</option>}
            {otherGroups.map((g) => (
              <option key={g.jid} value={g.jid}>
                {g.name} ({g.jid})
              </option>
            ))}
          </select>
        </label>
      )}
      {mode === "origin" && <input type="hidden" name={jidFieldName} value="" />}
    </fieldset>
  );
}
