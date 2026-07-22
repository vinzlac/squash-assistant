import { REAL_RULES } from "@squash-assistant/db/fixtures/realRules";
import { describeRuleInFrench } from "@squash-assistant/db/ruleDescription";
import { describe, expect, it } from "vitest";
import { extractRuleParamsFromDescription } from "./ruleParamsExtraction.js";

/**
 * Tests d'intégration réels (appel Anthropic facturé, non déterministe) —
 * pas dans `npm test` (voir vitest.config.ts / vitest.integration.config.ts,
 * npm run test:llm). Round-trip : describeRuleInFrench (déterministe) →
 * texte → extractRuleParamsFromDescription (LLM) → paramètres, comparés aux
 * vraies valeurs des 3 groupes connus. Ignoré silencieusement si
 * ANTHROPIC_API_KEY n'est pas configuré, pour ne jamais casser un run
 * accidentel de cette suite sans clé.
 */
describe.skipIf(!process.env.ANTHROPIC_API_KEY)("extractRuleParamsFromDescription (LLM réel)", () => {
  it.each(Object.entries(REAL_RULES))(
    "retrouve les paramètres de la règle %s à partir de sa description en français",
    async (_ruleId, rule) => {
      const description = describeRuleInFrench(rule);
      const extracted = await extractRuleParamsFromDescription(description);

      expect(extracted.candidateStartTimes).toEqual(rule.candidateStartTimes);
      expect(extracted.pollCron).toBe(rule.pollCron);
      expect(extracted.decisionCron).toBe(rule.decisionCron);
      expect(extracted.targetWeekdayOffset).toBe(rule.targetWeekdayOffset);
      expect(extracted.maxCourtsPerSlot).toBe(rule.maxCourtsPerSlot);
      expect(extracted.minPlayersPerCourt).toBe(rule.minPlayersPerCourt);
      expect(extracted.maxPlayersPerCourt).toBe(rule.maxPlayersPerCourt);
      expect(extracted.maxReservationsPerPlayer).toBe(rule.maxReservationsPerPlayer);
      expect(extracted.priorityBookers).toEqual(rule.priorityBookers);
      expect(extracted.preferMinPlayersPerCourt).toBe(rule.preferMinPlayersPerCourt);
      expect(extracted.courtPriority).toEqual(rule.courtPriority);
      expect(extracted.availabilityWindowHours).toBe(rule.availabilityWindowHours);
    },
    30_000,
  );
});
