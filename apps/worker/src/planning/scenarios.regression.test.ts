import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { simulateScenario, type ScenarioPlayerVote } from "./simulateScenario.js";
import type { BookingRule } from "../config.js";

interface ScenarioFixture {
  scenario: { name: string; players: ScenarioPlayerVote[]; apiUserId: string | null };
  rule: Pick<
    BookingRule,
    | "candidateStartTimes"
    | "maxReservationsPerPlayer"
    | "maxCourtsPerSlot"
    | "minPlayersPerCourt"
    | "maxPlayersPerCourt"
    | "preferMinPlayersPerCourt"
    | "courtPriority"
    | "maxDailyReservationsPerPlayer"
    | "substituteBookers"
    | "availabilityWindowHours"
    | "priorityBookers"
  >;
  expectedPlan: unknown;
}

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "scenarios");

function fullRule(partial: ScenarioFixture["rule"]): BookingRule {
  return {
    id: "fixture-rule",
    name: null,
    enabled: false,
    whatsappGroupJid: "fixture@test",
    resaSquashGroupId: "fixture-group",
    pollCron: "0 10 * * 2",
    decisionCron: "30 21 * * 2",
    targetWeekdayOffset: 7,
    description: null,
    ...partial,
  };
}

describe("scenarios de non-régression (exportés depuis le simulateur)", () => {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));

  if (files.length === 0) {
    it.skip("aucune fixture exportée pour le moment", () => {});
    return;
  }

  for (const file of files) {
    it(`${file} produit toujours le plan attendu`, () => {
      const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf-8")) as ScenarioFixture;
      const groups = simulateScenario(fullRule(fixture.rule), fixture.scenario.players, fixture.scenario.apiUserId);
      expect(groups).toEqual(fixture.expectedPlan);
    });
  }
});
