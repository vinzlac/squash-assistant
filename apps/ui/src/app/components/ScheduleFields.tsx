"use client";

import { useState } from "react";
import { WEEKDAY_NAMES_FR, triggerWeekday } from "@squash-assistant/db/ruleSchedule";

interface Props {
  targetWeekday?: number;
  pollDaysBefore?: number;
  pollTime?: string;
  decisionDaysBefore?: number;
  decisionTime?: string;
}

/**
 * Bloc « Planification » du formulaire de règle (ADR-030) : jour cible + décalages en
 * jours + heures. Composant client uniquement pour l'aperçu en français ("Sondage le lundi
 * à 10:00 …") recalculé à la saisie — les champs restent des inputs de formulaire natifs
 * lus par upsertRuleAction. Les noms `name` doivent rester identiques à ceux lus dans actions.ts.
 */
export function ScheduleFields(props: Props) {
  const [targetWeekday, setTargetWeekday] = useState(props.targetWeekday ?? 2);
  const [pollDaysBefore, setPollDaysBefore] = useState(props.pollDaysBefore ?? 7);
  const [pollTime, setPollTime] = useState(props.pollTime ?? "10:00");
  const [decisionDaysBefore, setDecisionDaysBefore] = useState(props.decisionDaysBefore ?? 7);
  const [decisionTime, setDecisionTime] = useState(props.decisionTime ?? "21:30");

  const pollDay = WEEKDAY_NAMES_FR[triggerWeekday(targetWeekday, pollDaysBefore)];
  const decisionDay = WEEKDAY_NAMES_FR[triggerWeekday(targetWeekday, decisionDaysBefore)];

  return (
    <fieldset>
      <legend>Planification</legend>
      <label>
        Jour de réservation visé
        <select name="targetWeekday" value={targetWeekday} onChange={(e) => setTargetWeekday(Number(e.target.value))}>
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <option key={d} value={d}>{WEEKDAY_NAMES_FR[d]}</option>
          ))}
        </select>
      </label>
      <label>
        Sondage : jours avant la date cible
        <input type="number" name="pollDaysBefore" min={1} value={pollDaysBefore} onChange={(e) => setPollDaysBefore(Number(e.target.value))} required />
      </label>
      <label>
        Sondage : heure
        <input type="time" name="pollTime" value={pollTime} onChange={(e) => setPollTime(e.target.value)} required />
      </label>
      <label>
        Décision (collecte + plan) : jours avant la date cible
        <input type="number" name="decisionDaysBefore" min={0} value={decisionDaysBefore} onChange={(e) => setDecisionDaysBefore(Number(e.target.value))} required />
      </label>
      <label>
        Décision : heure
        <input type="time" name="decisionTime" value={decisionTime} onChange={(e) => setDecisionTime(e.target.value)} required />
      </label>
      <p>
        Sondage le {pollDay} à {pollTime}, décision le {decisionDay} à {decisionTime}, pour le {WEEKDAY_NAMES_FR[targetWeekday]} suivant.
      </p>
    </fieldset>
  );
}
