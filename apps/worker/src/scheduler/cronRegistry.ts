import cron from "node-cron";
import type { Database } from "@squash-assistant/db/client";
import type { BookingRule } from "@squash-assistant/db/schema";
import { deriveCrons } from "@squash-assistant/db/ruleSchedule";
import { loadBookingRules } from "../bookingRules.js";
import type { PipelineGraph } from "../graph/buildGraph.js";
import type { TelegramConfig } from "../telegram/telegram.js";
import { cronExpressionMinutesEarlier, scheduleWithCronJitter } from "./cronJitter.js";

const TIMEZONE = "Europe/Paris";
/**
 * Demi-fenêtre de la confirmation. Le cron sonne ce nombre de minutes avant
 * l'heure configurée ; le délai aléatoire couvre le double, donc l'envoi tombe
 * dans [heure − 10 min, heure + 10 min). Nouveau tirage à chaque déclenchement.
 */
const CONFIRMATION_JITTER_HALF_MINUTES = 10;

type Stoppable = { stop: () => void };

interface RuleCronHandles {
  pollTask: Stoppable;
  decisionTask: Stoppable;
  confirmationTask: Stoppable;
  pendingTimeouts: Set<ReturnType<typeof setTimeout>>;
}

export interface SchedulerRuntime {
  graph: PipelineGraph;
  telegram: TelegramConfig;
  db: Database;
  /** Déclencheurs injectables pour tests — défaut = vrais triggerCron*. */
  onPoll: (rule: BookingRule) => Promise<void>;
  onDecision: (rule: BookingRule) => Promise<void>;
  onConfirmation: (rule: BookingRule) => Promise<void>;
  /** Tick global du rappel avant le match (ADR-036) — un seul pour toutes les règles. */
  onStartReminderTick: (now: Date) => Promise<void>;
}

const registry = new Map<string, RuleCronHandles>();
let runtime: SchedulerRuntime | null = null;

/** Tick global du rappel avant le match : hors registre par règle, donc conservé par reloadScheduler. */
const START_REMINDER_TICK_CRON = "* * * * *";
let startReminderTask: Stoppable | null = null;
let startReminderTickRunning = false;

function stopStartReminderTick(): void {
  startReminderTask?.stop();
  startReminderTask = null;
}

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
  handles.confirmationTask.stop();
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

  // Crons dérivés du jour cible (ADR-030) — jamais stockés en base.
  const { pollCron, decisionCron, confirmationCron } = deriveCrons(rule);

  const pollTask = cron.schedule(
    pollCron,
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
    decisionCron,
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

  const confirmationTickCron = cronExpressionMinutesEarlier(confirmationCron, CONFIRMATION_JITTER_HALF_MINUTES);
  const confirmationTask = cron.schedule(
    confirmationTickCron,
    () => {
      void (async () => {
        try {
          const { getBookingRuleById } = await import("../bookingRules.js");
          const fresh = await getBookingRuleById(rt.db, ruleId);
          if (!fresh?.enabled || !fresh.nextDayReminderEnabled) return;
          scheduleWithCronJitter(
            `${fresh.id} confirmationCron`,
            CONFIRMATION_JITTER_HALF_MINUTES * 2,
            () => rt.onConfirmation(fresh),
            Math.random,
            schedule,
          );
        } catch (err) {
          console.error(`[scheduler] confirmationCron « ${ruleId} » échec :`, err);
        }
      })();
    },
    { timezone: TIMEZONE },
  );

  registry.set(ruleId, { pollTask, decisionTask, confirmationTask, pendingTimeouts });
  console.log(
    `[scheduler] planifié « ${ruleId} » cible=${rule.targetWeekday} poll=${pollCron} (J-${rule.pollDaysBefore}) decision=${decisionCron} (J-${rule.decisionDaysBefore}) confirmation=${confirmationCron} (J-${rule.decisionDaysBefore}, tick ${confirmationTickCron} ±${CONFIRMATION_JITTER_HALF_MINUTES}min) jitter=${rule.cronJitterWindowMinutes ?? 60}min`,
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

  stopStartReminderTick();
  startReminderTask = cron.schedule(
    START_REMINDER_TICK_CRON,
    () => {
      if (startReminderTickRunning) return; // pas de chevauchement si le tick précédent tourne encore
      startReminderTickRunning = true;
      void rt
        .onStartReminderTick(new Date())
        .catch((err) => {
          console.error("[scheduler] tick rappel avant match échec :", err);
        })
        .finally(() => {
          startReminderTickRunning = false;
        });
    },
    { timezone: TIMEZONE },
  );
}

/** Test-only : reset module state. */
export function __resetCronRegistryForTests(): void {
  for (const id of [...registry.keys()]) clearRuleHandles(id);
  stopStartReminderTick();
  runtime = null;
}
