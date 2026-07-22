import type { BookingRule } from "./schema.js";

const WEEKDAY_NAMES_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

/**
 * Décrit un cron en français quand c'est un motif simple "M H * * D" (le seul
 * réellement utilisé dans ce projet — un déclenchement hebdomadaire à un jour
 * et une heure fixes). Retourne le cron brut si le format ne correspond pas.
 */
function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return `\`${cron}\` (format non reconnu)`;
  const [minuteRaw, hourRaw, dayOfMonth, month, dayOfWeekRaw] = parts;
  const minute = Number(minuteRaw);
  const hour = Number(hourRaw);
  const dayOfWeek = Number(dayOfWeekRaw);
  const isSimpleWeekly =
    dayOfMonth === "*" && month === "*" && !Number.isNaN(minute) && !Number.isNaN(hour) && !Number.isNaN(dayOfWeek);
  if (!isSimpleWeekly) return `\`${cron}\``;
  const dayName = WEEKDAY_NAMES_FR[dayOfWeek % 7];
  return `${dayName} à ${String(hour).padStart(2, "0")}H${String(minute).padStart(2, "0")}`;
}

export interface RuleDescriptionContext {
  /** Libellé lisible du groupe WhatsApp (huddle-bot `list_groups`). */
  whatsappGroupName?: string;
  /** Libellé lisible du groupe resa-squash (`list_my_groups`). */
  resaSquashGroupName?: string;
  /** userId resa-squash → "Prénom Nom" (`list_group_members`), pour les réservataires prioritaires. */
  playerNames?: Record<string, string>;
}

/**
 * Génère une description exhaustive en français de tous les paramètres d'une
 * BookingRule — déterministe, aucun appel LLM. Sert à la fois d'affichage UI
 * et de fixture pour les tests d'intégration "description → paramètres" côté
 * worker (le LLM reçoit cette description et doit retrouver les mêmes valeurs).
 */
export function describeRuleInFrench(rule: BookingRule, context: RuleDescriptionContext = {}): string {
  const label = rule.name ?? rule.id;
  const groupLabel = context.whatsappGroupName ? `${context.whatsappGroupName} (${rule.whatsappGroupJid})` : rule.whatsappGroupJid;
  const resaLabel = context.resaSquashGroupName
    ? `${context.resaSquashGroupName} (${rule.resaSquashGroupId})`
    : rule.resaSquashGroupId;
  const priorityBookersLabel =
    rule.priorityBookers.length > 0
      ? rule.priorityBookers.map((id) => context.playerNames?.[id] ?? id).join(", ")
      : null;

  const lines = [
    `Règle « ${label} » (id technique : ${rule.id}) — ${rule.enabled ? "actuellement active" : "actuellement désactivée"}.`,
    `Groupe WhatsApp concerné : ${groupLabel}. Groupe resa-squash associé pour les réservations : ${resaLabel}.`,
    `Le sondage WhatsApp ("qui joue ?") est envoyé chaque ${describeCron(rule.pollCron)}, proposant comme heures candidates : ${rule.candidateStartTimes.join(", ")}.`,
    `La collecte des votes puis le calcul du plan de réservation se déclenchent chaque ${describeCron(rule.decisionCron)}, pour une date cible ${rule.targetWeekdayOffset} jour(s) après ce déclenchement (J+${rule.targetWeekdayOffset}).`,
    `Chaque joueur confirmé vise ${rule.maxReservationsPerPlayer} créneau(x) de 45 minutes. Chaque court accueille entre ${rule.minPlayersPerCourt} et ${rule.maxPlayersPerCourt} joueurs, avec un maximum de ${rule.maxCourtsPerSlot} court(s) utilisés simultanément par vague.`,
    rule.preferMinPlayersPerCourt
      ? "En cas de manque de courts, le remplissage privilégié est le nombre MINIMUM de joueurs par court (plus de courts utilisés) ; une escalade automatique vers le remplissage MAXIMUM se déclenche seulement si la capacité manque encore (voir ADR-014)."
      : "Le remplissage privilégié est directement le nombre MAXIMUM de joueurs par court (moins de courts utilisés simultanément).",
    rule.courtPriority.length > 0
      ? `Les courts sont choisis dans cet ordre de priorité : ${rule.courtPriority.join(", ")}.`
      : "Aucun ordre de priorité de court n'est configuré (choix par défaut, ordre croissant des numéros).",
    priorityBookersLabel
      ? `Réservataires prioritaires (mis en tête des paires de réservation s'ils font partie des confirmés) : ${priorityBookersLabel}.`
      : "Aucun réservataire prioritaire n'est configuré pour cette règle.",
    `Si la capacité des courts manque encore après escalade, le plan cherche des créneaux jusqu'à ${rule.availabilityWindowHours}h après la 1ère heure candidate — au-delà de cette fenêtre, les joueurs concernés ne sont pas réservés et un avertissement de capacité est envoyé (ADR-014).`,
  ];

  return lines.join("\n\n");
}
