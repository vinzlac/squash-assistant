"use client";

import { useState } from "react";
import { SubmitButton } from "./SubmitButton";

type Props = {
  action: (formData: FormData) => void | Promise<void>;
  ruleId: string;
  jobId: string;
};

/**
 * La confirmation "go" peut venir de deux canaux équivalents : cliquer ici
 * (forceGoConfirmation, immédiat), ou répondre "go" sur Telegram (toujours
 * en dry-run — le polling tourne déjà en arrière-plan depuis l'étape 3, cf.
 * scheduler.ts awaitGoAndResume). Cocher "Valider le go dans Telegram"
 * n'appelle rien de plus côté serveur — ça retire juste le bouton de
 * confirmation immédiate pour ne pas court-circuiter par erreur l'attente
 * Telegram déjà en cours.
 *
 * `dryRun` est un state React contrôlé (pas `defaultChecked`) : la case
 * "Dry-run" n'est montée que dans la branche `!waitForTelegram` du JSX
 * ci-dessous — un aller-retour sur la case Telegram la démonte puis la
 * remonte, et une case non contrôlée reviendrait alors à sa valeur
 * `defaultChecked` d'origine (cochée), silencieusement, même après que
 * l'utilisateur l'ait décochée (bug constaté le 2026-07-21 : une "vraie"
 * réservation demandée est restée en dry-run sans erreur visible).
 */
export function GoConfirmationForm({ action, ruleId, jobId }: Props) {
  const [waitForTelegram, setWaitForTelegram] = useState(false);
  const [dryRun, setDryRun] = useState(true);

  return (
    <form action={action}>
      <input type="hidden" name="ruleId" value={ruleId} />
      <input type="hidden" name="jobId" value={jobId} />
      <label style={{ display: "block", marginBottom: "0.5rem" }}>
        <input type="checkbox" checked={waitForTelegram} onChange={(e) => setWaitForTelegram(e.target.checked)} />{" "}
        Valider le go dans Telegram (ne pas confirmer depuis cette page)
      </label>
      {waitForTelegram ? (
        <p className="muted">
          ⏳ En attente d'un "go" sur Telegram — réponds directement là-bas, la réservation continuera
          automatiquement dès réception (reste toujours en dry-run depuis ce canal).
        </p>
      ) : (
        <>
          <label style={{ display: "block", marginBottom: "0.5rem" }}>
            <input type="checkbox" name="dryRun" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            {" "}Dry-run (ne réserve pas réellement — décoche uniquement pour tester une vraie réservation)
          </label>
          <SubmitButton className="button-primary">Confirmer et annoncer</SubmitButton>
        </>
      )}
    </form>
  );
}
