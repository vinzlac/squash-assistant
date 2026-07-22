import type { JobRun, PipelineStage, PollTally, RuleExecutionStatus } from "../../../../../lib/worker";
import {
  cancelPollAction,
  editJobAction,
  triggerCollectVotesAction,
  triggerGoAction,
  triggerPlanAction,
  triggerRecollectVotesAction,
  triggerRetryAction,
  triggerSendPollAction,
} from "../../../../actions";
import { GoConfirmationForm } from "../../../../components/GoConfirmationForm";
import { SubmitButton } from "../../../../components/SubmitButton";

type StepState = "done" | "current" | "pending" | "error";
type StatusValues = RuleExecutionStatus["values"];

const STEP1_DONE: PipelineStage[] = [
  "awaiting-decision",
  "awaiting-plan",
  "awaiting-go",
  "error",
  "finished-no-plan",
  "finished-announced",
  "finished-cancelled",
];

function step1State(stage: PipelineStage): StepState {
  if (stage === "not-started") return "current";
  return STEP1_DONE.includes(stage) ? "done" : "pending";
}

/**
 * `computeStage` (worker) ne distingue pas quel nœud a planté sur
 * `stage === "error"` (voir ADR-010) — on le déduit ici de la présence de
 * `confirmedPlayerIdsByTime` : s'il est absent, CollectVotes n'a pas terminé,
 * donc l'erreur vient de là ; s'il est présent, CollectVotes a réussi et
 * l'erreur vient forcément de BookSlots (étape 3).
 */
function step2State(stage: PipelineStage, values: StatusValues): StepState {
  if (stage === "awaiting-decision") return "current";
  if (stage === "error" && !values.confirmedPlayerIdsByTime) return "error";
  if (values.confirmedPlayerIdsByTime) return "done";
  return "pending";
}

function step3State(stage: PipelineStage, values: StatusValues): StepState {
  if (stage === "awaiting-plan") return "current";
  if (stage === "error" && values.confirmedPlayerIdsByTime && !values.bookingPlanGroups) return "error";
  if (values.bookingPlanGroups) return "done";
  return "pending";
}

function step4State(stage: PipelineStage): StepState {
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

function RetryBlock({ ruleId, jobId, data }: { ruleId: string; jobId: string; data?: unknown }) {
  return (
    <>
      <p className="muted">❌ Une erreur est survenue pendant cette étape — voir le détail dans les événements ci-dessous.</p>
      <form action={triggerRetryAction}>
        <input type="hidden" name="ruleId" value={ruleId} />
        <input type="hidden" name="jobId" value={jobId} />
        <SubmitButton className="button-primary">Relancer</SubmitButton>
      </form>
      <StepDetail data={data} />
    </>
  );
}

export function Pipeline({
  ruleId,
  job,
  status,
  candidateStartTimes,
  pollQuestionPreview,
  pollTally,
  playerNames,
}: {
  ruleId: string;
  job: JobRun;
  status: RuleExecutionStatus;
  candidateStartTimes: string[];
  pollQuestionPreview: string;
  pollTally?: PollTally;
  playerNames: Record<string, string>;
}) {
  const { stage, values } = status;
  const displayPlayer = (userId: string) => playerNames[userId] ?? userId;

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
            <form style={{ marginBottom: "0.75rem" }}>
              <input type="hidden" name="ruleId" value={ruleId} />
              <input type="hidden" name="jobId" value={job.id} />
              <label>
                Date cible
                <input type="date" name="targetDate" defaultValue={job.targetDate} required />
              </label>
              <label>
                Heures candidates (séparées par virgules)
                <input
                  type="text"
                  name="candidateStartTimes"
                  defaultValue={candidateStartTimes.join(", ")}
                  placeholder="18H45, 19H30"
                  required
                />
              </label>
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                <SubmitButton formAction={editJobAction}>Mettre à jour</SubmitButton>
                <SubmitButton className="button-primary" formAction={triggerSendPollAction}>
                  Enregistrer et lancer le sondage
                </SubmitButton>
              </div>
            </form>
          </>
        )}
        {step1State(stage) === "done" && (
          <>
            <p className="muted">
              ✓ Envoyé pour le {status.targetDate} — {candidateStartTimes.join(", ")}.
            </p>
            {stage === "awaiting-decision" && job.pollMsgId && (
              <form action={cancelPollAction}>
                <input type="hidden" name="ruleId" value={ruleId} />
                <input type="hidden" name="jobId" value={job.id} />
                <SubmitButton>Annuler ce sondage (supprime le message WhatsApp)</SubmitButton>
              </form>
            )}
          </>
        )}
        {step1State(stage) === "done" && <StepDetail data={{ pollRequestId: values.pollRequestId }} />}
      </div>

      <div className="pipeline-arrow">→</div>

      <div className={stepClass(step2State(stage, values))}>
        <h3>2. Collecte des votes</h3>
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
            <p className="muted">Fige les votes actuels et résout les joueurs côté resa-squash, par heure choisie.</p>
            <form action={triggerCollectVotesAction}>
              <input type="hidden" name="ruleId" value={ruleId} />
              <input type="hidden" name="jobId" value={job.id} />
              <SubmitButton className="button-primary">Lire les réponses et les interpréter</SubmitButton>
            </form>
          </>
        )}
        {step2State(stage, values) === "error" && (
          <RetryBlock ruleId={ruleId} jobId={job.id} data={{ pollRequestId: values.pollRequestId }} />
        )}
        {step2State(stage, values) === "done" && values.confirmedPlayerIdsByTime && (
          <ul className="pipeline-plan">
            {Object.entries(values.confirmedPlayerIdsByTime).map(([time, ids]) => (
              <li key={time}>
                {time} : {ids.length} joueur(s) confirmé(s)
              </li>
            ))}
          </ul>
        )}
        {stage === "awaiting-plan" && (
          <form action={triggerRecollectVotesAction}>
            <input type="hidden" name="ruleId" value={ruleId} />
            <input type="hidden" name="jobId" value={job.id} />
            <SubmitButton>Relire les réponses (nouveau vote / vote changé)</SubmitButton>
          </form>
        )}
        {step2State(stage, values) === "pending" && !pollTally && <p className="muted">En attente de l'étape précédente.</p>}
        {step2State(stage, values) === "done" && (
          <StepDetail data={{ confirmedPlayerIdsByTime: values.confirmedPlayerIdsByTime }} />
        )}
      </div>

      <div className="pipeline-arrow">→</div>

      <div className={stepClass(step3State(stage, values))}>
        <h3>3. Plan de réservation</h3>
        {stage === "awaiting-plan" && (
          <>
            <p className="muted">Calcule un plan de réservation (dry-run) par heure ayant des joueurs confirmés.</p>
            <form action={triggerPlanAction}>
              <input type="hidden" name="ruleId" value={ruleId} />
              <input type="hidden" name="jobId" value={job.id} />
              <SubmitButton className="button-primary">Calculer le plan</SubmitButton>
            </form>
          </>
        )}
        {step3State(stage, values) === "error" && (
          <RetryBlock ruleId={ruleId} jobId={job.id} data={{ confirmedPlayerIdsByTime: values.confirmedPlayerIdsByTime }} />
        )}
        {step3State(stage, values) === "done" && values.bookingPlanGroups && (
          (() => {
            // N'affiche que les heures que quelqu'un a réellement votées (une heure
            // sans aucun confirmé n'intéresse personne, pas la peine de l'afficher
            // comme "échec") — mais garde une heure votée même si le plan a échoué
            // (effectif insuffisant), c'est une info utile, pas du bruit.
            const relevantGroups = values.bookingPlanGroups.filter(
              (g) =>
                g.plan.proposedBookings.length > 0 ||
                (values.confirmedPlayerIdsByTime?.[g.startTime]?.length ?? 0) > 0,
            );
            if (relevantGroups.length === 0) {
              return <p className="muted">— Aucun créneau possible (aucune heure votée n'a de joueur confirmé).</p>;
            }
            return (
              <ul className="pipeline-plan">
                {relevantGroups.map((g) => {
                  const expected = g.plan.meta.pairCount * g.plan.meta.slotsPerPlayer;
                  const shortfall = expected - g.plan.proposedBookings.length;
                  return (
                    <li key={g.startTime}>
                      {g.startTime} :
                      {g.plan.proposedBookings.length > 0 ? (
                        <ul>
                          {g.plan.proposedBookings.map((b, i) => {
                            const outOfWindow = g.outOfWindowSessionIds.includes(b.sessionId);
                            return (
                              <li key={i}>
                                {b.slotTime}–{b.slotEndTime} (court {b.court}) — {displayPlayer(b.userId)}
                                {b.partnerId ? ` et ${displayPlayer(b.partnerId)}` : ""}
                                {outOfWindow && (
                                  <span className="muted"> (hors fenêtre, non réservé)</span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        ` — ${g.plan.warnings.join(" ") || "Aucun créneau à réserver."}`
                      )}
                      {shortfall > 0 && (
                        <p className="muted" style={{ margin: "0.25rem 0 0" }}>
                          ⚠️ Capacité insuffisante à {g.startTime} — {shortfall} réservation(s) manquante(s).
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            );
          })()
        )}
        {step3State(stage, values) === "pending" && <p className="muted">En attente de l'étape précédente.</p>}
        {step3State(stage, values) === "done" && <StepDetail data={values.bookingPlanGroups} />}
      </div>

      <div className="pipeline-arrow">→</div>

      <div className={stepClass(step4State(stage))}>
        <h3>4. Réservation et annonce</h3>
        {stage === "awaiting-go" && values.bookingPlanGroups && (
          <>
            <p className="muted">Plan proposé — à confirmer avant l'annonce WhatsApp (créneaux hors fenêtre exclus, voir étape 3) :</p>
            <ul className="pipeline-plan">
              {values.bookingPlanGroups
                .map((g) => ({
                  ...g,
                  inWindowBookings: g.plan.proposedBookings.filter((b) => !g.outOfWindowSessionIds.includes(b.sessionId)),
                }))
                .filter((g) => g.inWindowBookings.length > 0)
                .map((g) => (
                  <li key={g.startTime}>
                    {g.startTime} :
                    <ul>
                      {g.inWindowBookings.map((b, i) => (
                        <li key={i}>
                          Court {b.court} : {b.slotTime}–{b.slotEndTime} — {displayPlayer(b.userId)}
                          {b.partnerId ? ` et ${displayPlayer(b.partnerId)}` : ""}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
            </ul>
            <GoConfirmationForm action={triggerGoAction} ruleId={ruleId} jobId={job.id} />
          </>
        )}
        {stage === "finished-announced" && (
          <>
            <p className="muted">✓ Confirmé et annoncé sur WhatsApp. Message envoyé :</p>
            <pre className="pipeline-preview" style={{ whiteSpace: "pre-wrap" }}>{values.announceMessage}</pre>
          </>
        )}
        {stage === "finished-cancelled" && <p className="muted">✗ Pas de confirmation reçue — aucune annonce.</p>}
        {stage === "finished-no-plan" && <p className="muted">— Rien à confirmer (aucun créneau proposé, voir étape 3).</p>}
        {step4State(stage) === "pending" && <p className="muted">En attente de l'étape précédente.</p>}
      </div>
    </div>
  );
}
