import type { JobRun, PipelineStage, PollTally, RuleExecutionStatus } from "../../../../../lib/worker";
import {
  cancelPollAction,
  editJobAction,
  triggerDecisionAction,
  triggerGoAction,
  triggerRetryAction,
  triggerSendPollAction,
} from "../../../../actions";
import { SubmitButton } from "../../../../components/SubmitButton";

type StepState = "done" | "current" | "pending" | "error";

const STEP1_DONE: PipelineStage[] = [
  "awaiting-decision",
  "awaiting-go",
  "error",
  "finished-no-plan",
  "finished-announced",
  "finished-cancelled",
];
const STEP2_DONE: PipelineStage[] = ["awaiting-go", "finished-no-plan", "finished-announced", "finished-cancelled"];

function step1State(stage: PipelineStage): StepState {
  if (stage === "not-started") return "current";
  return STEP1_DONE.includes(stage) ? "done" : "pending";
}

function step2State(stage: PipelineStage): StepState {
  if (stage === "awaiting-decision") return "current";
  if (stage === "error") return "error";
  return STEP2_DONE.includes(stage) ? "done" : "pending";
}

function step3State(stage: PipelineStage): StepState {
  if (stage === "awaiting-go") return "current";
  if (stage === "finished-announced" || stage === "finished-cancelled" || stage === "finished-no-plan") {
    return "done";
  }
  return "pending";
}

function stepClass(state: StepState): string {
  return `pipeline-step pipeline-step-${state}`;
}

function StepDetail({ data }: { data: unknown }) {
  if (data === undefined || data === null) return null;
  return (
    <details style={{ marginTop: "0.5rem" }}>
      <summary className="muted">détail</summary>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem" }}>{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

export function Pipeline({
  ruleId,
  job,
  status,
  sessionStartTime,
  pollQuestionPreview,
  pollTally,
}: {
  ruleId: string;
  job: JobRun;
  status: RuleExecutionStatus;
  sessionStartTime: string;
  pollQuestionPreview: string;
  pollTally?: PollTally;
}) {
  const { stage } = status;

  if (job.cancelledAt) {
    return <p className="muted">✗ Job annulé le {new Date(job.cancelledAt).toLocaleString("fr-FR")} (sondage supprimé).</p>;
  }

  return (
    <div className="pipeline">
      <div className={stepClass(step1State(stage))}>
        <h3>1. Sondage</h3>
        {stage === "not-started" && (
          <>
            <p className="pipeline-preview">« {pollQuestionPreview} »</p>
            <form action={editJobAction} style={{ marginBottom: "0.75rem" }}>
              <input type="hidden" name="ruleId" value={ruleId} />
              <input type="hidden" name="jobId" value={job.id} />
              <label>
                Date cible
                <input type="date" name="targetDate" defaultValue={job.targetDate} required />
              </label>
              <label>
                Heure de session
                <input
                  type="text"
                  name="sessionStartTime"
                  defaultValue={sessionStartTime}
                  placeholder="18H45"
                  required
                />
              </label>
              <button type="submit">Mettre à jour</button>
            </form>
            <form action={triggerSendPollAction}>
              <input type="hidden" name="ruleId" value={ruleId} />
              <input type="hidden" name="jobId" value={job.id} />
              <SubmitButton className="button-primary">Lancer le sondage</SubmitButton>
            </form>
          </>
        )}
        {step1State(stage) === "done" && (
          <>
            <p className="muted">✓ Envoyé pour le {status.targetDate}.</p>
            {stage === "awaiting-decision" && job.pollMsgId && (
              <form action={cancelPollAction}>
                <input type="hidden" name="ruleId" value={ruleId} />
                <input type="hidden" name="jobId" value={job.id} />
                <SubmitButton>Annuler ce sondage (supprime le message WhatsApp)</SubmitButton>
              </form>
            )}
          </>
        )}
        {step1State(stage) === "done" && <StepDetail data={{ pollRequestId: status.values.pollRequestId }} />}
      </div>

      <div className="pipeline-arrow">→</div>

      <div className={stepClass(step2State(stage))}>
        <h3>2. Collecte &amp; Plan</h3>
        {pollTally && (
          <div className="pipeline-preview">
            <p className="muted">Qui a répondu jusqu'ici :</p>
            <ul>
              {pollTally.responses.map((r) => (
                <li key={r.member}>
                  {r.member} — {r.statut}
                </li>
              ))}
            </ul>
            <a href={`/rules/${ruleId}/jobs/${job.id}`}>Rafraîchir les réponses</a>
          </div>
        )}
        {stage === "awaiting-decision" && (
          <>
            <p className="muted">Fige les votes actuels, résout les joueurs et propose un plan de réservation (dry-run).</p>
            <form action={triggerDecisionAction}>
              <input type="hidden" name="ruleId" value={ruleId} />
              <input type="hidden" name="jobId" value={job.id} />
              <SubmitButton className="button-primary">Lancer la décision</SubmitButton>
            </form>
          </>
        )}
        {stage === "error" && (
          <>
            <p className="muted">❌ Une erreur est survenue pendant cette étape — voir le détail dans les événements ci-dessous.</p>
            <form action={triggerRetryAction}>
              <input type="hidden" name="ruleId" value={ruleId} />
              <input type="hidden" name="jobId" value={job.id} />
              <SubmitButton className="button-primary">Relancer</SubmitButton>
            </form>
          </>
        )}
        {step2State(stage) === "done" && (
          <p className="muted">✓ {status.values.confirmedPlayerIds?.length ?? 0} joueur(s) confirmé(s).</p>
        )}
        {step2State(stage) === "pending" && !pollTally && <p className="muted">En attente de l'étape précédente.</p>}
        {step2State(stage) === "done" && (
          <StepDetail data={{ confirmedPlayerIds: status.values.confirmedPlayerIds }} />
        )}
      </div>

      <div className="pipeline-arrow">→</div>

      <div className={stepClass(step3State(stage))}>
        <h3>3. Confirmation &amp; Annonce</h3>
        {stage === "awaiting-go" && status.values.bookingPlan && (
          <>
            <p className="muted">Plan proposé — à confirmer avant l'annonce WhatsApp :</p>
            <ul className="pipeline-plan">
              {status.values.bookingPlan.proposedBookings.map((b, i) => (
                <li key={i}>
                  Court {b.court} : {b.slotTime}–{b.slotEndTime} — {b.userId}
                  {b.partnerId ? ` et ${b.partnerId}` : ""}
                </li>
              ))}
              {status.values.bookingPlan.proposedBookings.length === 0 && <li>Aucun créneau proposé.</li>}
            </ul>
            <form action={triggerGoAction}>
              <input type="hidden" name="ruleId" value={ruleId} />
              <input type="hidden" name="jobId" value={job.id} />
              <SubmitButton className="button-primary">Confirmer et annoncer</SubmitButton>
            </form>
          </>
        )}
        {stage === "finished-announced" && <p className="muted">✓ Confirmé et annoncé sur WhatsApp.</p>}
        {stage === "finished-cancelled" && <p className="muted">✗ Pas de confirmation reçue — aucune annonce.</p>}
        {stage === "finished-no-plan" && (
          <p className="muted">
            —{" "}
            {status.values.bookingPlan?.warnings?.length
              ? status.values.bookingPlan.warnings.join(" ")
              : "Aucun créneau à réserver ce jour-là."}
          </p>
        )}
        {step3State(stage) === "pending" && <p className="muted">En attente de l'étape précédente.</p>}
        {step3State(stage) === "done" && <StepDetail data={status.values.bookingPlan} />}
      </div>
    </div>
  );
}
