import type { JobRun, PipelineStage, PollTally, RuleExecutionStatus } from "../../../../../lib/worker";
import {
  cancelPollAction,
  editJobAction,
  triggerCollectVotesAction,
  triggerGoAction,
  triggerPlanAction,
  triggerRecollectVotesAction,
  triggerRecomputePlanAction,
  triggerRetryAction,
  triggerSendPollAction,
} from "../../../../actions";
import { GoConfirmationForm } from "../../../../components/GoConfirmationForm";
import { SubmitButton } from "../../../../components/SubmitButton";
import { resolvePlayerIdsInText } from "../../../../../lib/formatWarning";

type StepState = "done" | "current" | "pending" | "error";
type StatusValues = RuleExecutionStatus["values"];

/** Miroir du libellé exact de SUBSTITUTE_VOLUNTEER_POLL_OPTION (apps/worker/src/graph/nodes/pollQuestion.ts, ADR-017). */
const SUBSTITUTE_VOLUNTEER_STATUT = "Non, mais je peux prêter mon nom";

/**
 * États depuis lesquels un recalcul du plan est sûr côté worker (voir
 * SAFE_RECOMPUTE_STAGES dans scheduler.ts) — le bouton ne doit apparaître que
 * là, sinon l'action renvoie une erreur 500 côté worker.
 */
const SAFE_RECOMPUTE_STAGES: PipelineStage[] = ["awaiting-go", "finished-cancelled", "finished-no-plan"];

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

interface CourtBlock {
  court: number;
  start: string;
  end: string;
  players: string[];
}

function sameNames(players: Set<string>, names: string[]): boolean {
  return players.size === names.length && names.every((n) => players.has(n));
}

/**
 * Regroupe des réservations proposées par court, en fusionnant les créneaux
 * contigus (même logique que slotMerge.ts côté worker pour le message
 * WhatsApp, mais avec les joueurs en plus — utile pour visualiser d'un coup
 * d'œil qui joue sur quel court sur toute la vague, plutôt que par round.
 *
 * Ne fusionne que si c'est la même paire qui enchaîne (mêmes joueurs) — deux
 * paires différentes qui se succèdent sur le même court (une heure candidate
 * qui prend le relais d'une autre) restent des blocs distincts, sinon
 * l'affichage laisse croire à tort que 4 joueurs ont joué ensemble en continu.
 */
function mergeBookingsByCourt(
  bookings: Array<{ court: number; slotTime: string; slotEndTime: string; userId: string; partnerId?: string }>,
  displayPlayer: (userId: string) => string,
): CourtBlock[] {
  const byCourt = new Map<number, typeof bookings>();
  for (const b of bookings) {
    byCourt.set(b.court, [...(byCourt.get(b.court) ?? []), b]);
  }

  const blocks: CourtBlock[] = [];
  for (const [court, slots] of byCourt) {
    const sorted = [...slots].sort((a, b) => a.slotTime.localeCompare(b.slotTime));
    let current: { start: string; end: string; players: Set<string> } | null = null;
    for (const s of sorted) {
      const names = [displayPlayer(s.userId), ...(s.partnerId ? [displayPlayer(s.partnerId)] : [])];
      if (current && current.end === s.slotTime && sameNames(current.players, names)) {
        current.end = s.slotEndTime;
      } else {
        if (current) blocks.push({ court, start: current.start, end: current.end, players: [...current.players] });
        current = { start: s.slotTime, end: s.slotEndTime, players: new Set(names) };
      }
    }
    if (current) blocks.push({ court, start: current.start, end: current.end, players: [...current.players] });
  }

  return blocks.sort((a, b) => a.court - b.court || a.start.localeCompare(b.start));
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
  const displayWarning = (warning: string) => resolvePlayerIdsInText(warning, playerNames);

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
            {(() => {
              const answered = pollTally.responses.filter((r) => r.statut !== "aucune_reponse");
              const notAnswered = pollTally.responses.filter((r) => r.statut === "aucune_reponse");
              const byStatut = new Map<string, typeof answered>();
              for (const r of answered) {
                byStatut.set(r.statut, [...(byStatut.get(r.statut) ?? []), r]);
              }
              // "non" toujours en dernier — les "oui"/heures votées et "ambigu" comptent plus pour la
              // décision ; le prête-nom volontaire (ADR-017) juste avant "non" (une offre positive,
              // même partielle, prime sur un refus sec). SUBSTITUTE_VOLUNTEER_STATUT est un miroir du
              // libellé exact de pollQuestion.ts (apps/worker) — jamais désynchronisé sans le vouloir
              // puisqu'il vient tel quel de get_responses, pas d'une classification recalculée ici.
              const statutRank = (statut: string) =>
                statut === "non" ? 3 : statut === SUBSTITUTE_VOLUNTEER_STATUT ? 2 : statut === "ambigu" ? 1 : 0;
              const statuts = [...byStatut.keys()].sort((a, b) => statutRank(a) - statutRank(b) || a.localeCompare(b));
              return (
                <>
                  <p className="muted">Ont répondu ({answered.length}) :</p>
                  {statuts.map((statut) => (
                    <div key={statut}>
                      <p className="muted" style={{ margin: "0.25rem 0" }}>
                        {statut === SUBSTITUTE_VOLUNTEER_STATUT ? "Non mais Ok pour prête-nom" : statut} :
                      </p>
                      <ul>
                        {byStatut.get(statut)!.map((r) => (
                          <li key={r.member}>{r.member}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  <p className="muted">N'ont pas encore répondu ({notAnswered.length}) :</p>
                  <ul>
                    {notAnswered.map((r) => (
                      <li key={r.member}>{r.member}</li>
                    ))}
                  </ul>
                </>
              );
            })()}
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
            const courtBlocks = mergeBookingsByCourt(
              relevantGroups.flatMap((g) =>
                g.plan.proposedBookings.filter((b) => !g.outOfWindowSessionIds.includes(b.sessionId)),
              ),
              displayPlayer,
            );
            return (
              <>
                {courtBlocks.length > 0 && (
                  <>
                    <p className="muted" style={{ margin: "0 0 0.25rem" }}>
                      Vue par court (créneaux contigus fusionnés) :
                    </p>
                    <ul className="pipeline-plan" style={{ marginBottom: "0.75rem" }}>
                      {courtBlocks.map((c) => (
                        <li key={`${c.court}-${c.start}`}>
                          Court {c.court} : {c.start}–{c.end} — {c.players.join(", ")}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {SAFE_RECOMPUTE_STAGES.includes(stage) && (
                  <form action={triggerRecomputePlanAction} style={{ margin: "0 0 0.75rem" }}>
                    <input type="hidden" name="ruleId" value={ruleId} />
                    <input type="hidden" name="jobId" value={job.id} />
                    <SubmitButton>Recalculer le plan</SubmitButton>
                  </form>
                )}
                <p className="muted" style={{ margin: "0 0 0.25rem" }}>Détail par heure votée :</p>
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
                                  {outOfWindow && <span className="muted"> (hors fenêtre, non réservé)</span>}
                                </li>
                              );
                            })}
                          </ul>
                        ) : (
                          ` — ${g.plan.warnings.map(displayWarning).join(" ") || "Aucun créneau à réserver."}`
                        )}
                        {shortfall > 0 && (
                          <div className="muted" style={{ margin: "0.25rem 0 0" }}>
                            <p style={{ margin: 0 }}>
                              ⚠️ {shortfall} réservation(s) manquante(s) à {g.startTime} — voir le(s) motif(s) ci-dessous
                              (pas forcément un manque de courts) :
                            </p>
                            {g.plan.warnings.length > 0 && (
                              <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.25rem" }}>
                                {g.plan.warnings.map((w, i) => (
                                  <li key={i}>{displayWarning(w)}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            );
          })()
        )}
        {step3State(stage, values) === "pending" && <p className="muted">En attente de l'étape précédente.</p>}
        {step3State(stage, values) === "done" && (
          <StepDetail
            data={values.bookingPlanGroups?.map((g) => ({
              ...g,
              plan: {
                ...g.plan,
                proposedBookings: g.plan.proposedBookings.map((b) => ({
                  ...b,
                  userId: displayPlayer(b.userId),
                  partnerId: b.partnerId ? displayPlayer(b.partnerId) : b.partnerId,
                })),
              },
            }))}
          />
        )}
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
