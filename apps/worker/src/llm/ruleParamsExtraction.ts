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
  | "targetWeekday"
  | "pollDaysBefore"
  | "pollTime"
  | "decisionDaysBefore"
  | "decisionTime"
  | "maxCourtsPerSlot"
  | "minPlayersPerCourt"
  | "maxPlayersPerCourt"
  | "maxReservationsPerPlayer"
  | "priorityBookers"
  | "preferMinPlayersPerCourt"
  | "courtPriority"
  | "availabilityWindowHours"
  | "substituteBookers"
  | "maxDailyReservationsPerPlayer"
  | "unexpectedPlayersMargin"
  | "cronJitterWindowMinutes"
> & {
  /**
   * Optionnel : absent de `required` du schéma d'extraction, car une description sans joker
   * ne doit pas pousser le modèle à en inventer un. Voir ADR-024.
   */
  jokerBookerId?: string | null;
};

const EXTRACT_TOOL_NAME = "extract_rule_params";

const SYSTEM_PROMPT = `Tu extrais les paramètres techniques d'une règle de réservation de squash à partir de sa description en français.
La description suit toujours la même structure (générée par describeRuleInFrench) : jour de semaine visé pour la réservation, décalages en jours et heures
du sondage et de la décision, heures candidates, joueurs par court, courts par créneau, créneaux par joueur, réservataires prioritaires
(identifiants bruts s'ils apparaissent tels quels dans le texte), stratégie de remplissage min/max, priorité des courts, fenêtre de disponibilité,
plafond de résas/jour/joueur, prête-noms (identifiants bruts, par ordre de priorité), joker (identifiant brut, s'il y en a un), marge joueurs imprévus, flou horaire du sondage (minutes).
Réponds uniquement via l'outil fourni, avec les valeurs exactes trouvées dans le texte — ne devine jamais une valeur absente du texte.

JOUR CIBLE ET DÉCLENCHEMENTS :
- "La réservation vise chaque mardi" → targetWeekday = 2 (dimanche=0, lundi=1, mardi=2, mercredi=3, jeudi=4, vendredi=5, samedi=6).
- "Le sondage … est envoyé 7 jour(s) avant, le mardi à 10:00" → pollDaysBefore = 7, pollTime = "10:00" (le jour cité n'est PAS le jour cible, c'est le jour de déclenchement — ne t'en sers pas pour targetWeekday).
- "La collecte des votes … se déclenchent 4 jour(s) avant, le mardi à 21:30" → decisionDaysBefore = 4, decisionTime = "21:30".
- Les heures sont recopiées telles quelles au format HH:MM, sans jamais perdre les minutes ("21:30" → "21:30", pas "21:00").`;

const INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    candidateStartTimes: { type: "array", items: { type: "string" }, description: "Heures candidates, format TeamR (ex. \"18H45\")." },
    targetWeekday: { type: "integer", description: "Jour de semaine visé pour la réservation (dimanche=0 … samedi=6)." },
    pollDaysBefore: { type: "integer", description: "Nombre de jours avant la date cible où le sondage est envoyé." },
    pollTime: { type: "string", description: "Heure d'envoi du sondage, format HH:MM (ex. \"10:00\")." },
    decisionDaysBefore: { type: "integer", description: "Nombre de jours avant la date cible où la collecte des votes et le plan sont lancés." },
    decisionTime: { type: "string", description: "Heure de la décision, format HH:MM (ex. \"21:30\")." },
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
    maxDailyReservationsPerPlayer: {
      type: "integer",
      description: "Plafond de résas par joueur et par jour (limite de courtoisie du groupe, pas une limite TeamR).",
    },
    substituteBookers: {
      type: "array",
      items: { type: "string" },
      description:
        "Identifiants bruts des prête-noms utilisables en repli si un joueur attendu est à quota, dans l'ordre où ils apparaissent dans le texte.",
    },
    jokerBookerId: {
      type: "string",
      description:
        "Identifiant brut du joker (joueur au nom duquel une réservation refusée est reprise). Ne renvoyer ce champ que si le texte mentionne explicitement un joker — l'omettre sinon.",
    },
    unexpectedPlayersMargin: {
      type: "integer",
      description:
        "Nombre de joueurs imprévus à provisionner en plus des confirmés. Toujours renvoyer une valeur : 0 si le texte n'en mentionne pas.",
    },
    cronJitterWindowMinutes: {
      type: "integer",
      description:
        "Flou horaire en minutes après le déclenchement du sondage (0 = immédiat). Toujours renvoyer une valeur : 60 si le texte n'en mentionne pas explicitement (défaut historique).",
    },
  },
  required: [
    "candidateStartTimes",
    "targetWeekday",
    "pollDaysBefore",
    "pollTime",
    "decisionDaysBefore",
    "decisionTime",
    "maxCourtsPerSlot",
    "minPlayersPerCourt",
    "maxPlayersPerCourt",
    "maxReservationsPerPlayer",
    "priorityBookers",
    "preferMinPlayersPerCourt",
    "courtPriority",
    "availabilityWindowHours",
    "maxDailyReservationsPerPlayer",
    "substituteBookers",
    "unexpectedPlayersMargin",
    "cronJitterWindowMinutes",
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
