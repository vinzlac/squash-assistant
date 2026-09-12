import type { ClosureImpact, ClosureImpactEntry } from "./worker";

const STAGE_LABELS: Record<ClosureImpactEntry["stage"], string> = {
  "not-started": "pas encore démarré",
  "not-created": "sondage à venir",
  "awaiting-decision": "sondage en cours",
  "awaiting-plan": "votes figés, plan à calculer",
  "awaiting-go": "plan calculé, en attente du go",
  error: "en erreur",
  "finished-club-closed": "terminé (PUC fermé)",
  "finished-no-plan": "terminé (pas de plan)",
  "finished-announced": "terminé (annoncé)",
  "finished-cancelled": "terminé (pas de go)",
};

export function stageLabel(stage: ClosureImpactEntry["stage"]): string {
  return STAGE_LABELS[stage] ?? stage;
}

/** "18H45" → "18h45", "19H00" → "19h". */
export function formatClosedTimes(times: string[]): string {
  return times
    .map((t) => {
      const m = /^(\d{1,2})H(\d{2})$/i.exec(t);
      if (!m) return t;
      return m[2] === "00" ? `${m[1]}h` : `${m[1]}h${m[2]}`;
    })
    .join(", ");
}

function plural(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n > 1 ? pluralForm : singular}`;
}

export function impactSummary(impact: ClosureImpact): string {
  if (impact.running.length === 0 && impact.planned.length === 0 && impact.errored.length === 0) {
    return "Aucun job concerné.";
  }
  const parts: string[] = [];
  if (impact.running.length > 0) {
    parts.push(`${plural(impact.running.length, "job en cours sera arrêté", "jobs en cours seront arrêtés")}`);
  }
  if (impact.planned.length > 0) {
    parts.push(
      `${plural(impact.planned.length, "job prévu recevra le message de fermeture", "jobs prévus recevront le message de fermeture")}`,
    );
  }
  if (impact.errored.length > 0) {
    parts.push(`${plural(impact.errored.length, "job en erreur à annuler à la main", "jobs en erreur à annuler à la main")}`);
  }
  return `${parts.join(", ")}.`;
}
