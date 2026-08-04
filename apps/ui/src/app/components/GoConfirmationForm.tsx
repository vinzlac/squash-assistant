"use client";

import { useState } from "react";
import { SubmitButton } from "./SubmitButton";

type Props = {
  action: (formData: FormData) => void | Promise<void>;
  ruleId: string;
  jobId: string;
  /** Job créé par le scheduler — pas de case dry-run : confirmation = réservation réelle. */
  isAuto?: boolean;
};

/**
 * La confirmation "go" peut venir de deux canaux équivalents : cliquer ici
 * (forceGoConfirmation, immédiat), ou répondre "go" sur Telegram
 * (scheduler.ts awaitGoAndResume).
 *
 * - Job **auto** : pas de case dry-run — UI et Telegram déclenchent une vraie réservation.
 * - Job **manuel** : case dry-run (défaut cochée) ; Telegram reste en dry-run.
 *
 * `dryRun` est un state React contrôlé (pas `defaultChecked`) : la case
 * "Dry-run" n'est montée que dans la branche `!waitForTelegram` du JSX
 * ci-dessous — un aller-retour sur la case Telegram la démonte puis la
 * remonte, et une case non contrôlée reviendrait alors à sa valeur
 * `defaultChecked` d'origine (cochée), silencieusement, même après que
 * l'utilisateur l'ait décochée (bug constaté le 2026-07-21).
 */
export function GoConfirmationForm({ action, ruleId, jobId, isAuto = false }: Props) {
  const [waitForTelegram, setWaitForTelegram] = useState(false);
  const [dryRun, setDryRun] = useState(true);

  return (
    <form action={action}>
      <input type="hidden" name="ruleId" value={ruleId} />
      <input type="hidden" name="jobId" value={jobId} />
      {isAuto && <input type="hidden" name="dryRun" value="off" />}
      <label style={{ display: "block", marginBottom: "0.5rem" }}>
        <input type="checkbox" checked={waitForTelegram} onChange={(e) => setWaitForTelegram(e.target.checked)} />{" "}
        Valider le go dans Telegram (ne pas confirmer depuis cette page)
      </label>
      {waitForTelegram ? (
        <p className="muted">
          {isAuto
            ? '⏳ En attente d\'un "go" sur Telegram — réservation RÉELLE dès réception (job automatique).'
            : '⏳ En attente d\'un "go" sur Telegram — reste en dry-run depuis ce canal (job manuel).'}
        </p>
      ) : (
        <>
          {isAuto ? (
            <p className="muted" style={{ marginBottom: "0.5rem" }}>
              Job automatique : la confirmation déclenche une <strong>vraie réservation</strong> (pas de dry-run).
            </p>
          ) : (
            <label style={{ display: "block", marginBottom: "0.5rem" }}>
              <input type="checkbox" name="dryRun" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
              {" "}Dry-run (ne réserve pas réellement — décoche uniquement pour une vraie réservation)
            </label>
          )}
          <SubmitButton className="button-primary">Confirmer et annoncer</SubmitButton>
        </>
      )}
    </form>
  );
}
