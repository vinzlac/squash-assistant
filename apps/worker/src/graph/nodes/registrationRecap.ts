import type { UnresolvedVoter } from "../state.js";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION, formatInformalDate, formatSessionTime } from "./pollQuestion.js";

export interface RegistrationRecapInput {
  targetDate: string;
  candidateStartTimes: string[];
  confirmedPlayerIdsByTime: Record<string, string[]>;
  volunteerSubstituteIds: string[];
  unresolvedVoters: UnresolvedVoter[];
  /** userId → « Prénom Nom » renvoyé par lookup_player_by_phone à la collecte ; un non-identifié garde son nom WhatsApp. */
  voterNames: Record<string, string>;
}

/** Jamais d'identifiant resa-squash brut sur WhatsApp (spec 2026-10-09 §2.1). */
const UNKNOWN_PLAYER_LABEL = "un joueur";

const PHONE_LIKE = /^\+?[\d\s().-]+$/;

/** Le nom WhatsApp d'un non-identifié peut être un téléphone ou un JID : jamais affiché aux joueurs. */
function publicVoterName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || PHONE_LIKE.test(trimmed) || trimmed.includes("@")) return UNKNOWN_PLAYER_LABEL;
  return name;
}

/** ["A"] → "A", ["A","B"] → "A et B", ["A","B","C"] → "A, B et C". */
function joinFrench(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

/**
 * Récap WhatsApp des inscrits, envoyé à la collecte (spec 2026-10-09 §2.1) : concis, sans détail
 * technique ni ⚠️. Une ligne par heure ayant au moins un inscrit, remerciement des prête-noms
 * (identifiés ou non), puis l'annonce des courts qui suit.
 */
export function buildRegistrationRecapMessage(input: RegistrationRecapInput): string {
  const displayName = (userId: string): string => input.voterNames[userId] ?? UNKNOWN_PLAYER_LABEL;
  const date = formatInformalDate(input.targetDate);

  const timeLines = input.candidateStartTimes
    .map((time) => {
      const names = [
        ...(input.confirmedPlayerIdsByTime[time] ?? []).map(displayName),
        ...input.unresolvedVoters.filter((v) => v.option === time).map((v) => publicVoterName(v.name)),
      ];
      return names.length > 0 ? `⏰ ${formatSessionTime(time)} (${names.length}) : ${names.join(", ")}` : null;
    })
    .filter((line): line is string => line !== null);

  if (timeLines.length === 0) return `🔒 Inscriptions closes — ${date}\nPersonne cette semaine 😢`;

  const volunteers = [
    ...input.volunteerSubstituteIds.map(displayName),
    ...input.unresolvedVoters.filter((v) => v.option === SUBSTITUTE_VOLUNTEER_POLL_OPTION).map((v) => publicVoterName(v.name)),
  ];
  const thanks =
    volunteers.length === 0
      ? []
      : [`🙏 Merci à ${joinFrench(volunteers)} pour ${volunteers.length === 1 ? "le prête-nom" : "les prête-noms"} :)`];

  return [`🔒 Inscriptions closes — ${date} 🎾`, ...timeLines, ...thanks, "Les courts arrivent bientôt 😉"].join("\n");
}
