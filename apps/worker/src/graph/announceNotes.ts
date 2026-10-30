import { isSubstitutableReason } from "../planning/jokerSubstitution.js";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "./nodes/pollQuestion.js";
import type { ReservationFailure, UnresolvedVoter } from "./state.js";

const plural = (count: number, singular: string, many: string): string => `${count} ${count >= 2 ? many : singular}`;

/**
 * Pourquoi tous les créneaux n'ont pas pu être pris, dit aux joueurs (2026-10-30) : seulement le
 * manque de joueurs, jamais le détail technique d'un refus.
 * - `unregisteredCount` : votants sans compte resa-squash (exclus du plan).
 * - `missingSubstituteCount` : lignes refusées faute de crédit / de réinscription, que des
 *   prête-noms supplémentaires auraient permis de réserver (un prête-nom par ligne).
 * Rien à dire (chaîne vide) quand aucun créneau n'a été perdu.
 */
export function buildShortageNote(input: {
  hasShortfall: boolean;
  unregisteredCount: number;
  missingSubstituteCount: number;
}): string {
  const { hasShortfall, unregisteredCount, missingSubstituteCount } = input;
  if (!hasShortfall) return "";
  const reasons = [
    unregisteredCount > 0 ? `${plural(unregisteredCount, "joueur non inscrit", "joueurs non inscrits")}` : "",
    missingSubstituteCount > 0
      ? `il aurait fallu ${plural(missingSubstituteCount, "prête-nom", "prête-noms")} de plus pour réserver ${plural(missingSubstituteCount, "créneau", "créneaux")} de plus`
      : "",
  ].filter((reason) => reason !== "");
  if (reasons.length === 0) return "\n\n⚠️ Tous les créneaux n'ont pas pu être réservés.";
  return `\n\n⚠️ Tous les créneaux n'ont pas pu être réservés par manque de joueurs :\n${reasons.map((r) => `• ${r}`).join("\n")}`;
}

/**
 * Notes ajoutées sous les courts de l'annonce, selon le destinataire. Le groupe des joueurs ne
 * reçoit que la raison du manque (`buildShortageNote`) ; le détail « Non réservé » par créneau et le
 * compteur de joueurs sans court n'ont d'intérêt que pour l'organisateur, donc seulement quand
 * l'annonce est redirigée vers un autre groupe (test).
 */
export function buildAnnounceNotes(input: {
  toPlayersGroup: boolean;
  failures: ReservationFailure[];
  unresolvedVoters: UnresolvedVoter[];
  unplacedPlayerCount: number;
  failuresBlock: string;
}): { failuresNote: string; capacityNote: string } {
  const { toPlayersGroup, failures, unresolvedVoters, unplacedPlayerCount, failuresBlock } = input;
  const shortage = buildShortageNote({
    hasShortfall: failures.length > 0 || unplacedPlayerCount > 0,
    unregisteredCount: unresolvedVoters.filter((v) => v.option !== SUBSTITUTE_VOLUNTEER_POLL_OPTION).length,
    missingSubstituteCount: failures.filter((f) => isSubstitutableReason(f.reason)).length,
  });
  if (toPlayersGroup) return { failuresNote: "", capacityNote: shortage };
  const unplaced =
    unplacedPlayerCount > 0 ? `\n\n⚠️ ${unplacedPlayerCount} joueur(s) n'ont pas pu être réservé(s) cette semaine.` : "";
  return { failuresNote: failuresBlock, capacityNote: `${shortage}${unplaced}` };
}
