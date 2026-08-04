/**
 * Décide ce que doit faire decisionCron selon l'état du job — pure, testable.
 * Ne distingue pas manuel vs auto : si l'étape est déjà passée (UI ou cron), on saute.
 */
export type CronDecisionPlan =
  | { kind: "run-collect-and-plan" }
  | { kind: "skip-collect-run-plan"; skipMessage: string }
  | { kind: "skip-all"; skipMessage: string };

export function resolveCronDecisionPlan(status: {
  pausedOn?: string;
  stage: string;
}): CronDecisionPlan {
  if (status.pausedOn === "await-decision-window") {
    return { kind: "run-collect-and-plan" };
  }
  if (status.pausedOn === "await-plan-trigger") {
    return {
      kind: "skip-collect-run-plan",
      skipMessage: `collecte déjà faite (état : ${status.stage}) — je saute la collecte et calcule le plan`,
    };
  }
  const detail = status.pausedOn ? `${status.stage}, pause=${status.pausedOn}` : status.stage;
  return {
    kind: "skip-all",
    skipMessage: `étapes auto déjà avancées (état : ${detail}) — decisionCron ignoré`,
  };
}
