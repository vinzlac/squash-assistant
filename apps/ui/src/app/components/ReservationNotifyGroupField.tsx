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
}

/**
 * Choix du destinataire de l'annonce de réservation : soit le groupe du sondage,
 * soit un autre groupe WhatsApp sélectionné dans la liste huddle-bot.
 */
export function ReservationNotifyGroupField({
  pollGroupJid,
  pollGroupName,
  initialNotifyJid,
  groups,
}: Props) {
  const initialCustom =
    initialNotifyJid != null && initialNotifyJid !== "" && initialNotifyJid !== pollGroupJid;
  const [mode, setMode] = useState<"origin" | "custom">(initialCustom ? "custom" : "origin");
  const [customJid, setCustomJid] = useState(
    initialCustom ? initialNotifyJid! : (groups.find((g) => g.jid !== pollGroupJid)?.jid ?? ""),
  );

  const pollLabel = pollGroupName ? `${pollGroupName} (${pollGroupJid})` : pollGroupJid;
  const otherGroups = groups.filter((g) => g.jid !== pollGroupJid);

  return (
    <fieldset style={{ gridColumn: "1 / -1", border: "1px solid var(--border)", borderRadius: "8px", padding: "0.75rem 1rem" }}>
      <legend style={{ padding: "0 0.25rem" }}>Groupe de notification des réservations</legend>
      <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
        Destinataire du message WhatsApp d&apos;annonce (étape 4) — distinct du sondage, qui reste toujours
        sur le groupe d&apos;origine.
      </p>
      <input type="hidden" name="reservationNotifyMode" value={mode} />
      <label style={{ display: "block", marginBottom: "0.5rem" }}>
        <input
          type="radio"
          name="reservationNotifyModeRadio"
          checked={mode === "origin"}
          onChange={() => setMode("origin")}
        />{" "}
        Groupe d&apos;origine (celui du sondage) — {pollLabel}
      </label>
      <label style={{ display: "block", marginBottom: "0.5rem" }}>
        <input
          type="radio"
          name="reservationNotifyModeRadio"
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
            name="reservationNotifyWhatsappGroupJid"
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
      {mode === "origin" && <input type="hidden" name="reservationNotifyWhatsappGroupJid" value="" />}
    </fieldset>
  );
}
