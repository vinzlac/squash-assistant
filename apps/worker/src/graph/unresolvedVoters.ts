import type { UnresolvedVoter } from "./state.js";

function describeCause(voter: UnresolvedVoter): string {
  return voter.phone ? `${voter.phone}, numéro inconnu de resa-squash` : "pas de numéro WhatsApp";
}

/** Message Telegram (organisateur) envoyé à la collecte dès qu'un votant n'est pas identifié (spec 2026-10-09 §3.1). */
export function buildUnresolvedVotersMessage(ruleLabel: string, voters: UnresolvedVoter[]): string {
  const lines = voters.map((v) => `  • ${v.name} (${describeCause(v)}) — « ${v.option} »`);
  return (
    `[${ruleLabel}] ⚠️ ${voters.length} votant(s) non identifié(s) — impossible de savoir qui c'est, exclu(s) du plan :\n` +
    `${lines.join("\n")}\n` +
    "→ Associer ce numéro à leur compte TeamR/resa-squash, puis « Recalculer le plan » avant le go."
  );
}
