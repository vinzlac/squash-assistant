import type { BookingRule } from "./schema.js";
import { WEEKDAY_NAMES_FR, triggerWeekday } from "./ruleSchedule.js";

/** « 7 jour(s) avant, le mardi à 10:00 » — même dérivation que le scheduler. */
function describeTrigger(rule: BookingRule, daysBefore: number, time: string): string {
  const day = WEEKDAY_NAMES_FR[triggerWeekday(rule.targetWeekday, daysBefore)];
  return `${daysBefore} jour(s) avant, le ${day} à ${time}`;
}

export interface RuleDescriptionContext {
  /** Libellé lisible du groupe WhatsApp (huddle-bot `list_groups`). */
  whatsappGroupName?: string;
  /** Libellé lisible du groupe resa-squash (`list_my_groups`). */
  resaSquashGroupName?: string;
  /** userId resa-squash → "Prénom Nom" (`list_group_members`), pour les réservataires prioritaires. */
  playerNames?: Record<string, string>;
  /** Libellé du groupe de notification des réservations (si distinct du groupe sondage). */
  reservationNotifyWhatsappGroupName?: string;
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
  const substituteBookersLabel =
    rule.substituteBookers.length > 0
      ? rule.substituteBookers.map((id) => context.playerNames?.[id] ?? id).join(", ")
      : null;
  const jokerBookerLabel = rule.jokerBookerId
    ? (context.playerNames?.[rule.jokerBookerId] ?? rule.jokerBookerId)
    : null;

  const notifyJid = rule.reservationNotifyWhatsappGroupJid?.trim();
  const notifyLabel = notifyJid
    ? context.reservationNotifyWhatsappGroupName
      ? `${context.reservationNotifyWhatsappGroupName} (${notifyJid})`
      : notifyJid
    : null;

  const lines = [
    `Règle « ${label} » (id technique : ${rule.id}) — ${rule.enabled ? "actuellement active" : "actuellement désactivée"}.`,
    `Groupe WhatsApp concerné : ${groupLabel}. Groupe resa-squash associé pour les réservations : ${resaLabel}.`,
    notifyLabel
      ? `L'annonce WhatsApp des créneaux réservés est envoyée vers un groupe distinct : ${notifyLabel} (le sondage reste sur le groupe d'origine).`
      : "L'annonce WhatsApp des créneaux réservés est envoyée sur le même groupe que le sondage (groupe d'origine).",
    `La réservation vise chaque ${WEEKDAY_NAMES_FR[rule.targetWeekday]}, avec comme heures candidates : ${rule.candidateStartTimes.join(", ")}.`,
    `Le sondage WhatsApp ("qui joue ?") est envoyé ${describeTrigger(rule, rule.pollDaysBefore, rule.pollTime)}.`,
    `La collecte des votes puis le calcul du plan de réservation se déclenchent ${describeTrigger(rule, rule.decisionDaysBefore, rule.decisionTime)}.`,
    rule.cronJitterWindowMinutes > 0
      ? `Après chaque déclenchement automatique du sondage, un flou aléatoire d'au plus ${rule.cronJitterWindowMinutes} minute(s) est appliqué avant l'envoi (l'heure configurée est le début de la fenêtre) ; la décision part pile à l'heure configurée.`
      : "Le sondage automatique part immédiatement à l'heure configurée, sans flou horaire ; la décision aussi.",
    `Chaque joueur confirmé vise ${rule.maxReservationsPerPlayer} créneau(x) de 45 minutes. Chaque court accueille entre ${rule.minPlayersPerCourt} et ${rule.maxPlayersPerCourt} joueurs, avec un maximum de ${rule.maxCourtsPerSlot} court(s) utilisés simultanément par vague.`,
    rule.preferMinPlayersPerCourt
      ? `En cas de manque de courts, le remplissage privilégié est le nombre minimum de joueurs par court (${rule.minPlayersPerCourt}, donc plus de courts utilisés) ; une escalade automatique vers le remplissage maximum (${rule.maxPlayersPerCourt}) se déclenche seulement si la capacité manque encore (voir ADR-014).`
      : `Le remplissage privilégié est directement le nombre maximum de joueurs par court (${rule.maxPlayersPerCourt}, donc moins de courts utilisés simultanément).`,
    rule.courtPriority.length > 0
      ? `Les courts sont choisis dans cet ordre de priorité : ${rule.courtPriority.join(", ")}.`
      : "Aucun ordre de priorité de court n'est configuré (choix par défaut, ordre croissant des numéros).",
    priorityBookersLabel
      ? `Réservataires prioritaires (mis en tête des paires de réservation s'ils font partie des confirmés) : ${priorityBookersLabel}.`
      : "Aucun réservataire prioritaire n'est configuré pour cette règle.",
    `Si la capacité des courts manque encore après escalade, le plan cherche des créneaux jusqu'à ${rule.availabilityWindowHours}h après la 1ère heure candidate — au-delà de cette fenêtre, les joueurs concernés ne sont pas réservés et un avertissement de capacité est envoyé (ADR-014).`,
    `Plafond de réservations par joueur et par jour : ${rule.maxDailyReservationsPerPlayer} (limite de courtoisie propre à ce groupe, pas une limite TeamR).`,
    substituteBookersLabel
      ? `Prête-noms utilisables en repli si un joueur attendu est à quota, par ordre de priorité : ${substituteBookersLabel}.`
      : "Aucun prête-nom n'est configuré pour cette règle.",
    jokerBookerLabel
      ? `Joker : si TeamR refuse un joueur au moment de réserver (pas réinscrit pour la saison, ou quota de réservations atteint), la réservation est reprise avec ${jokerBookerLabel} en partenaire — sans limite de nombre, y compris plusieurs fois au même horaire, à condition qu'il reste un titulaire bien inscrit.`
      : "Aucun joker n'est configuré : une réservation refusée par TeamR (joueur pas réinscrit ou à quota) fait échouer le lot.",
    rule.unexpectedPlayersMargin > 0
      ? `Marge joueurs imprévus : ${rule.unexpectedPlayersMargin} joueur(s) supplémentaire(s) provisionné(s) en plus des confirmés (traités comme des confirmés réels, mêmes créneaux).`
      : "Aucune marge joueurs imprévus n'est configurée pour cette règle.",
    rule.requireTelegramGoForAutoJobs
      ? "Les jobs automatiques attendent une confirmation Telegram « go » avant de réserver et d'annoncer."
      : "Les jobs automatiques enchaînent directement en réservation réelle après le calcul du plan, sans attendre de confirmation Telegram.",
  ];

  return lines.join("\n\n");
}
