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
  /**
   * Le sondage est-il fermé pour les joueurs qui reçoivent ce récap ? Faux quand le sondage du groupe
   * n'a pas été supprimé (ancien sondage, garde-fou d'âge, msgId inconnu, échec) : on ne dit alors pas
   * « Inscriptions closes ». Vrai en mode test (récap sur un autre groupe, clôture simulée).
   */
  pollClosed: boolean;
}

/** Jamais d'identifiant resa-squash brut sur WhatsApp (spec 2026-10-09 §2.1). */
const UNKNOWN_PLAYER_LABEL = "un joueur";

const PHONE_LIKE = /^\+?[\d\s().-]+$/;

/**
 * Suite d'au moins 6 chiffres, espaces, points, tirets, parenthèses ou « + » intercalés compris
 * (« (+33) » de tête absorbé, pour ne pas laisser de parenthèse orpheline).
 */
const EMBEDDED_PHONE = /[(+]*\d(?:[\s().+-]*\d){5,}\)?/g;

/** « 2024-2025 », « 2024–2025 », « 2024/2025 » : une plage d'années, pas un numéro. */
const YEAR_RANGE = /^(?:19|20)\d{2}\s*[-–/]\s*(?:19|20)\d{2}$/;

/** Parenthèses vides ou séparateurs laissés par le retrait d'un numéro. */
const EMPTY_BRACKETS = /\(\s*\)|\[\s*\]/g;
const LEADING_JUNK = /^[\s\-–—/|,;:)\]]+/;
const TRAILING_JUNK = /[\s\-–—/|,;:([]+$/;

/** « Vince +33 6 63 89 21 86 » → « Vince » ; un nom sans numéro est rendu tel quel. */
function stripEmbeddedPhone(name: string): string {
  const stripped = name.replace(EMBEDDED_PHONE, (match) => (YEAR_RANGE.test(match) ? match : " "));
  if (stripped === name) return name;
  return stripped.replace(EMPTY_BRACKETS, " ").replace(/\s{2,}/g, " ").replace(LEADING_JUNK, "").replace(TRAILING_JUNK, "");
}

/** Caractères de format invisibles (U+200E/U+200F, U+202A–U+202E, U+2066–U+2069…) que WhatsApp met autour des numéros. */
const FORMAT_CHARS = /\p{Cf}/gu;

/**
 * Le nom WhatsApp d'un non-identifié peut être ou contenir un téléphone, ou être un JID : jamais affiché aux joueurs.
 * Partagé avec la synthèse du groupe test (announce.ts).
 */
export function publicVoterName(name: string): string {
  const cleaned = stripEmbeddedPhone(name.replace(FORMAT_CHARS, ""));
  const trimmed = cleaned.trim();
  if (trimmed === "" || PHONE_LIKE.test(trimmed) || trimmed.includes("@")) return UNKNOWN_PLAYER_LABEL;
  return cleaned;
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
  const title = input.pollClosed ? `🔒 Inscriptions closes — ${date}` : `📋 Inscrits — ${date}`;

  const timeLines = input.candidateStartTimes
    .map((time) => {
      const names = [
        ...(input.confirmedPlayerIdsByTime[time] ?? []).map(displayName),
        ...input.unresolvedVoters.filter((v) => v.option === time).map((v) => publicVoterName(v.name)),
      ];
      return names.length > 0 ? `⏰ ${formatSessionTime(time)} (${names.length}) : ${names.join(", ")}` : null;
    })
    .filter((line): line is string => line !== null);

  if (timeLines.length === 0) return `${title}\n${input.pollClosed ? "Personne cette semaine 😢" : "Personne pour l'instant 😢"}`;

  const volunteers = [
    ...input.volunteerSubstituteIds.map(displayName),
    ...input.unresolvedVoters.filter((v) => v.option === SUBSTITUTE_VOLUNTEER_POLL_OPTION).map((v) => publicVoterName(v.name)),
  ];
  const thanks =
    volunteers.length === 0
      ? []
      : [`🙏 Merci à ${joinFrench(volunteers)} pour ${volunteers.length === 1 ? "le prête-nom" : "les prête-noms"} :)`];

  return [`${title} 🎾`, ...timeLines, ...thanks, "Les courts arrivent bientôt 😉"].join("\n");
}
