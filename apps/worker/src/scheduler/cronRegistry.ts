import cron from "node-cron";
import type { Database } from "@squash-assistant/db/client";
import type { BookingRule } from "@squash-assistant/db/schema";
import { loadBookingRules } from "../bookingRules.js";
import type { PipelineGraph } from "../graph/buildGraph.js";
import type { TelegramConfig } from "../telegram/telegram.js";
import { scheduleWithCronJitter } from "./cronJitter.js";

const TIMEZONE = "Europe/Paris";
const REMINDER_CRON_EXPRESSION = "5 0 * * *";
const REMINDER_JITTER_WINDOW_MINUTES = 10;

type Stoppable = { stop: () => void };

interface RuleCronHandles {
  pollTask: Stoppable;
  decisionTask: Stoppable;
  reminderTask: Stoppable;
  pendingTimeouts: Set<ReturnType<typeof setTimeout>>;
}

export interface SchedulerRuntime {
  graph: PipelineGraph;
  telegram: TelegramConfig;
  db: Database;
  /** Déclencheurs injectables pour tests — défaut = vrais triggerCron*. */
  onPoll: (rule: BookingRule) => Promise<void>;
  onDecision: (rule: BookingRule) => Promise<void>;
  onReminder: (rule: BookingRule) => Promise<void>;
}

const registry = new Map<string, RuleCronHandles>();
let runtime: SchedulerRuntime | null = null;

export function getScheduledRuleIds(): string[] {
  return [...registry.keys()].sort();
}

function requireRuntime(): SchedulerRuntime {
  if (!runtime) {
    throw new Error("Scheduler non initialisé — appeler scheduleBookingRules au démarrage.");
  }
  return runtime;
}

function clearRuleHandles(ruleId: string): void {
  const handles = registry.get(ruleId);
  if (!handles) return;
  for (const t of handles.pendingTimeouts) clearTimeout(t);
  handles.pendingTimeouts.clear();
  handles.pollTask.stop();
  handles.decisionTask.stop();
  handles.reminderTask.stop();
  registry.delete(ruleId);
}

function trackableSchedule(
  pendingTimeouts: Set<ReturnType<typeof setTimeout>>,
): (cb: () => void, ms: number) => ReturnType<typeof setTimeout> {
  return (cb, ms) => {
    const id = setTimeout(() => {
      pendingTimeouts.delete(id);
      cb();
    }, ms);
    pendingTimeouts.add(id);
    return id;
  };
}

function scheduleOne(rule: BookingRule, rt: SchedulerRuntime): void {
  clearRuleHandles(rule.id);
  if (!rule.enabled) return;

  const pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();
  const schedule = trackableSchedule(pendingTimeouts);
  const ruleId = rule.id;

  const pollTask = cron.schedule(
    rule.pollCron,
    () => {
      void (async () => {
        try {
          const { getBookingRuleById } = await import("../bookingRules.js");
          const fresh = await getBookingRuleById(rt.db, ruleId);
          if (!fresh?.enabled) return;
          scheduleWithCronJitter(
            `${fresh.id} pollCron`,
            fresh.cronJitterWindowMinutes ?? 60,
            () => rt.onPoll(fresh),
            Math.random,
            schedule,
          );
        } catch (err) {
          console.error(`[scheduler] pollCron « ${ruleId} » échec :`, err);
        }
      })();
    },
    { timezone: TIMEZONE },
  );

  const decisionTask = cron.schedule(
    rule.decisionCron,
    () => {
      void (async () => {
        try {
          const { getBookingRuleById } = await import("../bookingRules.js");
          const fresh = await getBookingRuleById(rt.db, ruleId);
          if (!fresh?.enabled) return;
          // Pas de jitter ici (2026-08-12) : la collecte des votes doit se déclencher pile à
          // l'heure configurée — seul pollCron conserve le flou (cronJitterWindowMinutes).
          await rt.onDecision(fresh);
        } catch (err) {
          console.error(`[scheduler] decisionCron « ${ruleId} » échec :`, err);
        }
      })();
    },
    { timezone: TIMEZONE },
  );

  const reminderTask = cron.schedule(
    REMINDER_CRON_EXPRESSION,
    () => {
      void (async () => {
        const { getBookingRuleById } = await import("../bookingRules.js");
        const fresh = await getBookingRuleById(rt.db, ruleId);
        if (!fresh?.enabled || !fresh.nextDayReminderEnabled) return;
        scheduleWithCronJitter(
          `${fresh.id} reminderCron`,
          REMINDER_JITTER_WINDOW_MINUTES,
          () => rt.onReminder(fresh),
          Math.random,
          schedule,
        );
      })();
    },
    { timezone: TIMEZONE },
  );

  registry.set(ruleId, { pollTask, decisionTask, reminderTask, pendingTimeouts });
  console.log(
    `[scheduler] planifié « ${ruleId} » poll=${rule.pollCron} decision=${rule.decisionCron} jitter=${rule.cronJitterWindowMinutes ?? 60}min`,
  );
}

/**
 * Stoppe toutes les tâches, relit les règles enabled en DB, replanifie.
 * Appelé au boot et après upsert/toggle/delete (à chaud, sans redémarrer le pod).
 */
export async function reloadScheduler(): Promise<{ enabledRuleIds: string[] }> {
  const rt = requireRuntime();
  for (const id of [...registry.keys()]) clearRuleHandles(id);

  const rules = await loadBookingRules(rt.db);
  const enabled = rules.filter((r) => r.enabled);
  for (const rule of enabled) {
    scheduleOne(rule, rt);
  }
  const enabledRuleIds = enabled.map((r) => r.id).sort();
  console.log(
    enabledRuleIds.length > 0
      ? `[scheduler] reload — actif : ${enabledRuleIds.join(", ")}`
      : "[scheduler] reload — aucune règle active",
  );
  return { enabledRuleIds };
}

/**
 * Initialise le runtime et planifie les règles enabled (boot).
 * Les callbacks onPoll/onDecision sont fournis par scheduler.ts pour éviter
 * les imports circulaires avec triggerCron*.
 */
export function startCronRegistry(
  rules: BookingRule[],
  rt: Omit<SchedulerRuntime, "onPoll" | "onDecision"> & {
    onPoll: SchedulerRuntime["onPoll"];
    onDecision: SchedulerRuntime["onDecision"];
  },
): void {
  runtime = rt;
  for (const id of [...registry.keys()]) clearRuleHandles(id);
  for (const rule of rules.filter((r) => r.enabled)) {
    scheduleOne(rule, rt);
  }
}

/** Test-only : reset module state. */
export function __resetCronRegistryForTests(): void {
  for (const id of [...registry.keys()]) clearRuleHandles(id);
  runtime = null;
}
