"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionResult, ClosureFormInput } from "../actions";
import { formatClosedTimes, impactSummary, stageLabel } from "../../lib/closureImpactLabels";
import type { ClosureImpact, ClosureImpactEntry, CreateClosureResponse } from "../../lib/worker";

type Props = {
  previewAction: (input: ClosureFormInput) => Promise<ActionResult<ClosureImpact>>;
  confirmAction: (input: ClosureFormInput) => Promise<ActionResult<CreateClosureResponse>>;
  disabled?: boolean;
};

type Phase = { kind: "edit" } | { kind: "preview"; impact: ClosureImpact } | { kind: "done"; result: CreateClosureResponse };

const EMPTY: ClosureFormInput = { allDay: true, startDate: "", endDate: "", startsAt: "", endsAt: "", label: "" };
const LABEL_REQUIRED = "Le libellé (raison de la fermeture) est obligatoire.";

function unexpectedError(err: unknown): string {
  return `Erreur inattendue : ${err instanceof Error ? err.message : String(err)}`;
}

function ImpactTable({ title, entries, note }: { title: string; entries: ClosureImpactEntry[]; note: string }) {
  if (entries.length === 0) return null;
  return (
    <>
      <h4 style={{ margin: "0.75rem 0 0.25rem" }}>{title}</h4>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>{note}</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Groupe / règle</th>
              <th>Date cible</th>
              <th>Étape</th>
              <th>Heures fermées</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={`${e.ruleId}:${e.jobId ?? e.targetDate}`}>
                <td>{e.ruleLabel}</td>
                <td>{e.targetDate}</td>
                <td>{stageLabel(e.stage)}</td>
                <td>{formatClosedTimes(e.closedTimes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Formulaire de fermeture PUC en deux temps (spec 2026-09-12) : saisie → aperçu des jobs
 * impactés → confirmation. Rien n'est enregistré avant « Confirmer la fermeture ».
 * État contrôlé (comme GoConfirmationForm) : la saisie survit à l'aller-retour aperçu ↔ édition.
 */
export function ClubClosureAddForm({ previewAction, confirmAction, disabled = false }: Props) {
  const router = useRouter();
  const [input, setInput] = useState<ClosureFormInput>(EMPTY);
  const [phase, setPhase] = useState<Phase>({ kind: "edit" });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const update = (patch: Partial<ClosureFormInput>) => setInput((prev) => ({ ...prev, ...patch }));

  const onPreview = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (input.label.trim() === "") {
      setError(LABEL_REQUIRED);
      return;
    }
    startTransition(async () => {
      try {
        const result = await previewAction(input);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setPhase({ kind: "preview", impact: result.value });
      } catch (err) {
        setError(unexpectedError(err));
      }
    });
  };

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await confirmAction(input);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setPhase({ kind: "done", result: result.value });
        setInput(EMPTY);
        router.refresh();
      } catch (err) {
        setError(unexpectedError(err));
      }
    });
  };

  if (phase.kind === "done") {
    const { result } = phase;
    return (
      <div style={{ marginTop: "1rem" }}>
        <p>✓ Fermeture enregistrée.</p>
        {result.cascadeError && (
          <p className="badge-off">
            ⚠️ Fermeture enregistrée, mais le calcul d&apos;impact a échoué : {result.cascadeError}. Ne la recrée pas — annule à la main les jobs en cours concernés depuis leur page.
          </p>
        )}
        {result.cancelled.length > 0 && (
          <p>
            {result.cancelled.length} job(s) arrêté(s) : {result.cancelled.map((c) => `${c.ruleLabel} (${c.targetDate})`).join(", ")} — détail par job dans Telegram et sur la page du job.
          </p>
        )}
        {result.failed.length > 0 && (
          <p className="badge-off">
            Échecs : {result.failed.map((f) => `${f.ruleId}/${f.jobId} — ${f.error}`).join(" ; ")}
          </p>
        )}
        <button type="button" onClick={() => setPhase({ kind: "edit" })}>Ajouter une autre fermeture</button>
      </div>
    );
  }

  return (
    <form onSubmit={onPreview}>
      <fieldset disabled={disabled || pending || phase.kind === "preview"} style={{ border: 0, padding: 0, margin: "1rem 0 0" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <input type="checkbox" checked={input.allDay} onChange={(e) => update({ allDay: e.target.checked })} />
          Toute la journée
          <span className="muted">(une ou plusieurs dates civiles, sans choisir l&apos;heure)</span>
        </label>

        <div className="form-grid">
          {input.allDay ? (
            <>
              <label>
                Du
                <input type="date" required value={input.startDate} onChange={(e) => update({ startDate: e.target.value })} />
              </label>
              <label>
                Au
                <input type="date" required value={input.endDate} onChange={(e) => update({ endDate: e.target.value })} />
              </label>
            </>
          ) : (
            <>
              <label>
                Début
                <input type="datetime-local" required value={input.startsAt} onChange={(e) => update({ startsAt: e.target.value })} />
              </label>
              <label>
                Fin
                <input type="datetime-local" required value={input.endsAt} onChange={(e) => update({ endsAt: e.target.value })} />
              </label>
            </>
          )}
          <label>
            Libellé (raison, obligatoire)
            <input type="text" required placeholder="tournoi, travaux, 15 août…" value={input.label} onChange={(e) => update({ label: e.target.value })} />
          </label>
        </div>
      </fieldset>

      {error && <p className="badge-off" style={{ marginTop: "0.5rem" }}>{error}</p>}

      {phase.kind === "edit" ? (
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={disabled || pending}>
            {pending && <span className="spinner" aria-hidden="true" />}
            Vérifier l&apos;impact
          </button>
        </div>
      ) : (
        <div style={{ marginTop: "1rem" }}>
          <p><strong>{impactSummary(phase.impact)}</strong></p>
          <ImpactTable
            title="Jobs en cours — seront arrêtés"
            entries={phase.impact.running}
            note="Le sondage WhatsApp sera supprimé et le groupe prévenu (message avec la raison)."
          />
          <ImpactTable
            title="Jobs prévus"
            entries={phase.impact.planned}
            note="Recevront le message de fermeture à la place du sondage."
          />
          <ImpactTable
            title="Jobs en erreur"
            entries={phase.impact.errored}
            note="À annuler à la main depuis la page du job — aucune action automatique."
          />
          <div className="form-actions">
            <button type="button" onClick={() => setPhase({ kind: "edit" })} disabled={pending}>Annuler</button>
            <button
              type="button"
              className={phase.impact.running.length > 0 ? "button-danger" : "button-primary"}
              onClick={onConfirm}
              disabled={pending}
            >
              {pending && <span className="spinner" aria-hidden="true" />}
              Confirmer la fermeture
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
