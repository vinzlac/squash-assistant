import Anthropic from "@anthropic-ai/sdk";

/** Même modèle que huddle-bot (classification des votes) — rapide et peu coûteux, suffisant pour une extraction structurée. */
export const HAIKU_MODEL = "claude-haiku-4-5-20251001";

let _anthropic: Anthropic | null = null;

/** Singleton paresseux — n'exige ANTHROPIC_API_KEY qu'au premier appel réel, pas au chargement du module. */
export function getAnthropic(): Anthropic {
  if (!_anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY manquant — impossible d'appeler l'API Anthropic.");
    }
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}
