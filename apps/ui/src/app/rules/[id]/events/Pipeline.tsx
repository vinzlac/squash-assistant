import type { PipelineStage, RuleExecutionStatus } from "../../../../lib/worker";
import { buildPollQuestionPreview, computeTargetDate } from "../../../../lib/pipelinePreview";
import { triggerDecisionAction, triggerGoAction, triggerSendPollAction } from "../../../actions";

type StepState = "done" | "current" | "pending";

const STEP1_DONE: PipelineStage[] = [
  "awaiting-decision",
  "awaiting-go",
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

export function Pipeline({
  ruleId,
  status,
  targetWeekdayOffset,
}: {
  ruleId: string;
  status: RuleExecutionStatus;
  targetWeekdayOffset: number;
}) {
  const { stage } = status;
  const previewTargetDate = computeTargetDate(new Date(), targetWeekdayOffset);

  return (
    <div className="pipeline">
      <div className={stepClass(step1State(stage))}>
        <h3>1. Sondage</h3>
        {stage === "not-started" && (
          <>
            <p className="muted">
              Sera envoyé pour le <strong>{previewTargetDate}</strong> :
            </p>
            <p className="pipeline-preview">« {buildPollQuestionPreview(previewTargetDate)} »</p>
            <form action={triggerSendPollAction}>
              <input type="hidden" name="id" value={ruleId} />
              <button type="submit" className="button-primary">
                Lancer le sondage
              </button>
            </form>
          </>
        )}
        {step1State(stage) === "done" && (
          <p className="muted">✓ Envoyé pour le {status.targetDate}.</p>
        )}
      </div>

      <div className="pipeline-arrow">→</div>

      <div className={stepClass(step2State(stage))}>
        <h3>2. Collecte &amp; Plan</h3>
        {stage === "awaiting-decision" && (
          <>
            <p className="muted">Lit les réponses au sondage et propose un plan de réservation (dry-run).</p>
            <form action={triggerDecisionAction}>
              <input type="hidden" name="id" value={ruleId} />
              <button type="submit" className="button-primary">
                Lancer la décision
              </button>
            </form>
          </>
        )}
        {step2State(stage) === "done" && (
          <p className="muted">
            ✓ {status.values.confirmedPlayerIds?.length ?? 0} joueur(s) confirmé(s).
          </p>
        )}
        {step2State(stage) === "pending" && <p className="muted">En attente de l'étape précédente.</p>}
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
                  Court {b.court} : {b.beginTime}–{b.endTime} — {b.players.join(" et ")}
                </li>
              ))}
              {status.values.bookingPlan.proposedBookings.length === 0 && <li>Aucun créneau proposé.</li>}
            </ul>
            <form action={triggerGoAction}>
              <input type="hidden" name="id" value={ruleId} />
              <button type="submit" className="button-primary">
                Confirmer et annoncer
              </button>
            </form>
          </>
        )}
        {stage === "finished-announced" && <p className="muted">✓ Confirmé et annoncé sur WhatsApp.</p>}
        {stage === "finished-cancelled" && <p className="muted">✗ Pas de confirmation reçue — aucune annonce.</p>}
        {stage === "finished-no-plan" && <p className="muted">— Aucun créneau à réserver ce jour-là.</p>}
        {step3State(stage) === "pending" && <p className="muted">En attente de l'étape précédente.</p>}
      </div>
    </div>
  );
}
