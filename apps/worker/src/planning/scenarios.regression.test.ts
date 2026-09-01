import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { simulateScenario, type ScenarioPlayerVote } from "./simulateScenario.js";
import type { BookingRule } from "../config.js";

interface ScenarioFixture {
  scenario: { name: string; players: ScenarioPlayerVote[] };
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
    unexpectedPlayersMargin: 0,
    reservationNotifyWhatsappGroupJid: null,
    cronJitterWindowMinutes: 60,
    requireTelegramGoForAutoJobs: true,
    nextDayReminderEnabled: false,
    jokerBookerId: null,
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
    const parsed = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf-8")) as ScenarioFixture | ScenarioFixture[];
    // Un fichier peut contenir un seul scénario (export unitaire) ou un tableau
    // (export groupé "tous les scénarios validés", voir simulator/page.tsx).
    const fixtures = Array.isArray(parsed) ? parsed : [parsed];

    for (const fixture of fixtures) {
      it(`${file} — ${fixture.scenario.name} produit toujours le plan attendu`, () => {
        const groups = simulateScenario(fullRule(fixture.rule), fixture.scenario.players, null);
        expect(groups).toEqual(fixture.expectedPlan);
      });
    }
  }
});
