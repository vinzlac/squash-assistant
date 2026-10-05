/**
 * Lit un couple « mode / JID » d'un champ de choix de groupe de notification
 * (`ReservationNotifyGroupField`) : `custom` + JID non vide → le JID, sinon `null`
 * (= groupe d'origine, celui du sondage).
 */
export function parseNotifyGroup(formData: FormData, modeFieldName: string, jidFieldName: string): string | null {
  const mode = String(formData.get(modeFieldName) ?? "origin");
  const jid = String(formData.get(jidFieldName) ?? "").trim();
  return mode === "custom" && jid ? jid : null;
}
