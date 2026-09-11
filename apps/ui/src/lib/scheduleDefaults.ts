import { validateRuleSchedule } from "@squash-assistant/db/ruleSchedule";

/**
 * Défauts globaux de planification (ADR-030) : pré-remplissent le bloc « Planification »
 * d'une NOUVELLE règle (création sans duplication). Éditables dans /settings, persistés
 * dans app_settings (lecture/écriture : scheduleDefaultsStore.ts — ce module reste pur, importable
 * côté client). Les règles existantes portent leurs propres valeurs — jamais touchées.
 */
export interface ScheduleDefaults {
  defaultPollDaysBefore: number;
  defaultPollTime: string;
  defaultDecisionDaysBefore: number;
  defaultDecisionTime: string;
}

/** Repli si la ligne singleton n'existe pas encore — identique aux DEFAULT SQL (profil historique). */
export const SCHEDULE_DEFAULTS_FALLBACK: ScheduleDefaults = {
  defaultPollDaysBefore: 7,
  defaultPollTime: "10:00",
  defaultDecisionDaysBefore: 7,
  defaultDecisionTime: "21:30",
};

/** Mêmes invariants qu'une règle (N ≥ 1, 0 ≤ M ≤ N, heures) — le jour cible n'intervient pas. */
export function validateScheduleDefaults(d: ScheduleDefaults): string[] {
  return validateRuleSchedule({
    targetWeekday: 0,
    pollDaysBefore: d.defaultPollDaysBefore,
    pollTime: d.defaultPollTime,
    decisionDaysBefore: d.defaultDecisionDaysBefore,
    decisionTime: d.defaultDecisionTime,
  });
}
