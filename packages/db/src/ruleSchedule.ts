/**
 * Planification pilotée par la date cible (ADR-030) : la règle dit quel jour
 * de la semaine on veut jouer et combien de jours avant on sonde / on décide ;
 * les crons sont dérivés d'ici, jamais stockés. Fonctions pures, partagées
 * entre le worker (cronRegistry), les actions serveur de l'UI (validation) et
 * l'aperçu du formulaire de règle.
 */
export interface RuleSchedule {
  /** 0 = dimanche … 6 = samedi (convention JS/cron). */
  targetWeekday: number;
  /** N : le sondage part N jours avant la date cible (≥ 1). */
  pollDaysBefore: number;
  /** "HH:MM", Europe/Paris. */
  pollTime: string;
  /** M : collecte des votes + plan M jours avant la date cible (0 ≤ M ≤ N). */
  decisionDaysBefore: number;
  /** "HH:MM", Europe/Paris. */
  decisionTime: string;
}

export const WEEKDAY_NAMES_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Jour de déclenchement = (jour cible − N) mod 7, toujours dans [0, 6] même pour N > 7. */
export function triggerWeekday(targetWeekday: number, daysBefore: number): number {
  return (((targetWeekday - daysBefore) % 7) + 7) % 7;
}

function cronFor(time: string, weekday: number): string {
  const [hour, minute] = time.split(":").map(Number);
  return `${minute} ${hour} * * ${weekday}`;
}

/** Expressions node-cron (5 champs) du sondage et de la décision. Suppose `validateRuleSchedule(s)` vide. */
export function deriveCrons(s: RuleSchedule): { pollCron: string; decisionCron: string } {
  return {
    pollCron: cronFor(s.pollTime, triggerWeekday(s.targetWeekday, s.pollDaysBefore)),
    decisionCron: cronFor(s.decisionTime, triggerWeekday(s.targetWeekday, s.decisionDaysBefore)),
  };
}

/** Liste des violations d'invariants, en français (vide = valide). */
export function validateRuleSchedule(s: RuleSchedule): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(s.targetWeekday) || s.targetWeekday < 0 || s.targetWeekday > 6) {
    errors.push(`Jour cible invalide : ${s.targetWeekday} (attendu 0 = dimanche … 6 = samedi).`);
  }
  if (!TIME_RE.test(s.pollTime)) {
    errors.push(`Heure du sondage invalide : « ${s.pollTime} » (attendu HH:MM).`);
  }
  if (!TIME_RE.test(s.decisionTime)) {
    errors.push(`Heure de décision invalide : « ${s.decisionTime} » (attendu HH:MM).`);
  }
  if (!Number.isInteger(s.pollDaysBefore) || s.pollDaysBefore < 1) {
    errors.push("Le sondage doit être lancé au moins 1 jour avant la date cible.");
  }
  if (!Number.isInteger(s.decisionDaysBefore) || s.decisionDaysBefore < 0) {
    errors.push("Le décalage de la décision doit être un entier ≥ 0.");
  } else if (s.decisionDaysBefore > s.pollDaysBefore) {
    errors.push(
      `La décision (${s.decisionDaysBefore} j avant) ne peut pas précéder le sondage (${s.pollDaysBefore} j avant).`,
    );
  } else if (
    s.decisionDaysBefore === s.pollDaysBefore &&
    TIME_RE.test(s.pollTime) &&
    TIME_RE.test(s.decisionTime) &&
    s.decisionTime <= s.pollTime
  ) {
    errors.push(
      `Même jour : l'heure de décision (${s.decisionTime}) doit être après l'heure du sondage (${s.pollTime}).`,
    );
  }
  return errors;
}
