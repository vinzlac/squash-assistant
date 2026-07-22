import type Anthropic from "@anthropic-ai/sdk";
import type { BookingRule } from "@squash-assistant/db/schema";
import { getAnthropic, HAIKU_MODEL } from "./anthropicClient.js";

/**
 * Sous-ensemble de BookingRule réellement "décrit" en prose par
 * describeRuleInFrench (packages/db) — exclut id/name/enabled/whatsappGroupJid/
 * resaSquashGroupId, qui sont choisis via l'UI (dropdowns, contexte de page),
 * pas rédigés en texte libre par l'utilisateur.
 */
export type ExtractableRuleParams = Pick<
  BookingRule,
  | "candidateStartTimes"
  | "pollCron"
  | "decisionCron"
  | "targetWeekdayOffset"
  | "maxCourtsPerSlot"
  | "minPlayersPerCourt"
  | "maxPlayersPerCourt"
  | "maxReservationsPerPlayer"
  | "priorityBookers"
  | "preferMinPlayersPerCourt"
  | "courtPriority"
  | "availabilityWindowHours"
>;

const EXTRACT_TOOL_NAME = "extract_rule_params";

const SYSTEM_PROMPT = `Tu extrais les paramètres techniques d'une règle de réservation de squash à partir de sa description en français.
La description suit toujours la même structure (générée par describeRuleInFrench) : jour/heure du sondage et de la décision (crons),
heures candidates, décalage de jour cible, joueurs par court, courts par créneau, créneaux par joueur, réservataires prioritaires
(identifiants bruts s'ils apparaissent tels quels dans le texte), stratégie de remplissage min/max, priorité des courts, fenêtre de disponibilité.
Réponds uniquement via l'outil fourni, avec les valeurs exactes trouvées dans le texte — ne devine jamais une valeur absente du texte.`;

const INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    candidateStartTimes: { type: "array", items: { type: "string" }, description: "Heures candidates, format TeamR (ex. \"18H45\")." },
    pollCron: { type: "string", description: "Expression cron (5 champs) du jour/heure d'envoi du sondage." },
    decisionCron: { type: "string", description: "Expression cron (5 champs) du jour/heure de la décision de réservation." },
    targetWeekdayOffset: { type: "integer", description: "Nombre de jours entre le déclenchement et la date réservée (J+N)." },
    maxCourtsPerSlot: { type: "integer", description: "Nombre maximum de courts utilisés simultanément par vague." },
    minPlayersPerCourt: { type: "integer", description: "Nombre minimum de joueurs par court." },
    maxPlayersPerCourt: { type: "integer", description: "Nombre maximum de joueurs par court." },
    maxReservationsPerPlayer: { type: "integer", description: "Nombre de créneaux de 45 min visés par joueur." },
    priorityBookers: {
      type: "array",
      items: { type: "string" },
      description: "Identifiants bruts des réservataires prioritaires, dans l'ordre où ils apparaissent dans le texte.",
    },
    preferMinPlayersPerCourt: {
      type: "boolean",
      description: "true si le remplissage privilégié est le nombre MINIMUM de joueurs par court, false si c'est le MAXIMUM directement.",
    },
    courtPriority: { type: "array", items: { type: "integer" }, description: "Ordre de priorité des numéros de court." },
    availabilityWindowHours: { type: "integer", description: "Fenêtre en heures après la 1ère heure candidate pour étaler les joueurs." },
  },
  required: [
    "candidateStartTimes",
    "pollCron",
    "decisionCron",
    "targetWeekdayOffset",
    "maxCourtsPerSlot",
    "minPlayersPerCourt",
    "maxPlayersPerCourt",
    "maxReservationsPerPlayer",
    "priorityBookers",
    "preferMinPlayersPerCourt",
    "courtPriority",
    "availabilityWindowHours",
  ],
};

/**
 * Extrait les paramètres structurés d'une règle à partir d'une description en
 * français libre — via Claude (tool-use forcé, même pattern que la
 * classification des votes côté huddle-bot). Ne réserve rien, ne touche pas la
 * base : fonction pure côté effets (un seul appel API), à brancher plus tard
 * sur un bouton "Générer" (description → paramètres) dans l'UI.
 */
export async function extractRuleParamsFromDescription(description: string): Promise<ExtractableRuleParams> {
  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: description }],
    tools: [{ name: EXTRACT_TOOL_NAME, description: "Renvoie les paramètres extraits de la description.", input_schema: INPUT_SCHEMA }],
    tool_choice: { type: "tool", name: EXTRACT_TOOL_NAME },
  });

  const toolUseBlock = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUseBlock) {
    throw new Error("La réponse Claude ne contient pas d'appel d'outil exploitable.");
  }
  return toolUseBlock.input as ExtractableRuleParams;
}
