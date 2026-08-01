"use client";

import { useState } from "react";
import type { BookingRule, Scenario, ScenarioPlayer } from "@squash-assistant/db/schema";
import {
  computeScenarioPlanAction,
  saveScenarioAction,
  validateScenarioAction,
} from "../../../../actions";
import { SubmitButton } from "../../../../components/SubmitButton";

type ScenarioFixtureRule = Pick<
  BookingRule,
  | "candidateStartTimes"
  | "maxReservationsPerPlayer"
  | "maxCourtsPerSlot"
  | "minPlayersPerCourt"
  | "maxPlayersPerCourt"
  | "preferMinPlayersPerCourt"
  | "courtPriority"
  | "maxDailyReservationsPerPlayer"
  | "substituteBookers"
  | "availabilityWindowHours"
  | "priorityBookers"
>;

interface Props {
  ruleId: string;
  scenario: Scenario;
  candidateStartTimes: string[];
  playerNames: Record<string, string>;
  rule: ScenarioFixtureRule;
}

const NO_VOTE = "non";
const SUBSTITUTE_VOTE = "prete-nom";

export function ScenarioEditor({ ruleId, scenario, candidateStartTimes, playerNames, rule }: Props) {
  const [players, setPlayers] = useState<ScenarioPlayer[]>(scenario.players);
  const [apiUserId, setApiUserId] = useState<string>(scenario.apiUserId ?? "");
  const availablePlayerIds = Object.keys(playerNames).filter((id) => !players.some((p) => p.playerId === id));

  function addPlayer(playerId: string): void {
    if (!playerId) return;
    setPlayers((prev) => [...prev, { playerId, name: playerNames[playerId] ?? playerId, vote: NO_VOTE }]);
  }

  function setVote(playerId: string, vote: string): void {
    setPlayers((prev) => prev.map((p) => (p.playerId === playerId ? { ...p, vote } : p)));
  }

  function removePlayer(playerId: string): void {
    setPlayers((prev) => prev.filter((p) => p.playerId !== playerId));
    if (apiUserId === playerId) setApiUserId("");
  }

  const plan = scenario.lastPlan as
    | Array<{ startTime: string; plan: { proposedBookings: Array<{ court: number; slotTime: string; slotEndTime: string; userId: string; partnerId?: string }>; warnings: string[] } }>
    | null;

  return (
    <div>
      <form action={saveScenarioAction}>
        <input type="hidden" name="bookingRuleId" value={ruleId} />
        <input type="hidden" name="scenarioId" value={scenario.id} />
        <input type="hidden" name="playersJson" value={JSON.stringify(players)} />

        <div className="form-grid">
          <label>
            Nom
            <input type="text" name="name" defaultValue={scenario.name} required />
          </label>
        </div>

        <h2>Joueurs</h2>
        <table className="card">
          <thead>
            <tr>
              <th>Joueur</th>
              <th>Vote</th>
              <th>Titulaire (exempté)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.playerId}>
                <td>{p.name}</td>
                <td>
                  <select value={p.vote} onChange={(e) => setVote(p.playerId, e.target.value)}>
                    {candidateStartTimes.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                    <option value={SUBSTITUTE_VOTE}>Prête mon nom</option>
                    <option value={NO_VOTE}>Non</option>
                  </select>
                </td>
                <td>
                  <input
                    type="radio"
                    name="apiUserIdRadio"
                    checked={apiUserId === p.playerId}
                    onChange={() => setApiUserId(p.playerId)}
                  />
                </td>
                <td>
                  <button type="button" className="button" onClick={() => removePlayer(p.playerId)}>
                    Retirer
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <input type="hidden" name="apiUserId" value={apiUserId} />

        <div className="form-actions">
          <select onChange={(e) => addPlayer(e.target.value)} value="">
            <option value="">+ Ajouter un joueur…</option>
            {availablePlayerIds.map((id) => (
              <option key={id} value={id}>
                {playerNames[id]}
              </option>
            ))}
          </select>
          <SubmitButton className="button-primary">Sauvegarder</SubmitButton>
        </div>
      </form>

      <form action={computeScenarioPlanAction} style={{ marginTop: "1rem" }}>
        <input type="hidden" name="bookingRuleId" value={ruleId} />
        <input type="hidden" name="scenarioId" value={scenario.id} />
        <SubmitButton className="button-primary">Calculer le plan</SubmitButton>
      </form>

      {plan && (
        <div className="pipeline-step" style={{ marginTop: "1rem" }}>
          <h2>Plan calculé</h2>
          {plan.map((g) => (
            <div key={g.startTime}>
              <h3>{g.startTime}</h3>
              {g.plan.proposedBookings.length === 0 ? (
                <p className="muted">Aucun créneau ({g.plan.warnings.join(" ")})</p>
              ) : (
                <ul>
                  {g.plan.proposedBookings.map((b, i) => (
                    <li key={i}>
                      Court {b.court} — {b.slotTime}-{b.slotEndTime} — {playerNames[b.userId] ?? b.userId}
                      {b.partnerId ? ` et ${playerNames[b.partnerId] ?? b.partnerId}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              {g.plan.warnings.length > 0 && (
                <ul className="muted">
                  {g.plan.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}

          <div className="form-actions">
            <form action={validateScenarioAction}>
              <input type="hidden" name="bookingRuleId" value={ruleId} />
              <input type="hidden" name="scenarioId" value={scenario.id} />
              <input type="hidden" name="validated" value="true" />
              <SubmitButton className="button-primary">Valider (OK)</SubmitButton>
            </form>
            <form action={validateScenarioAction}>
              <input type="hidden" name="bookingRuleId" value={ruleId} />
              <input type="hidden" name="scenarioId" value={scenario.id} />
              <input type="hidden" name="validated" value="false" />
              <SubmitButton className="button">Invalider (pas OK)</SubmitButton>
            </form>
            {scenario.validated === true && (
              <a
                className="button"
                href={`data:application/json,${encodeURIComponent(
                  JSON.stringify(
                    { scenario: { name: scenario.name, players, apiUserId: apiUserId || null }, rule, expectedPlan: plan },
                    null,
                    2,
                  ),
                )}`}
                download={`${scenario.name.replace(/\W+/g, "-").toLowerCase()}.json`}
              >
                Exporter
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
