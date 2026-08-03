"use server";

import { and, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bookingRules, type ScenarioPlayer } from "@squash-assistant/db/schema";
import { describeRuleInFrench } from "@squash-assistant/db/ruleDescription";
import { requireAdmin } from "../lib/authz";
import { getDb } from "../lib/db";
import { listHuddleBotGroups } from "../lib/huddleBot";
import { listResaSquashGroups } from "../lib/resaSquash";
import { setVisibleWhatsappGroupJids } from "../lib/settings";
import {
  createScenario,
  deleteScenario,
  duplicateScenario,
  ruleHasScenarios,
  updateScenario,
  type CreateScenarioInput,
} from "../lib/scenarios";
import {
  cancelPoll,
  createJob,
  editJob,
  generateRuleParams,
  getGroupMemberNames,
  simulateScenario,
  triggerJobAction,
  type ExtractableRuleParams,
} from "../lib/worker";

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Recalcule et stocke la description en français d'une règle (mise en cache —
 * évite de refaire les 3 résolutions de noms à chaque affichage de la page
 * d'édition). Best-effort : n'échoue jamais la sauvegarde si huddle-bot/
 * resa-squash sont indisponibles, se contente de stocker une description
 * avec les identifiants bruts dans ce cas.
 */
async function refreshRuleDescription(bookingRuleId: string): Promise<void> {
  const [current] = await getDb().select().from(bookingRules).where(eq(bookingRules.id, bookingRuleId));
  if (!current) return;

  const [whatsappGroups, resaSquashGroups, playerNames] = await Promise.all([
    listHuddleBotGroups().catch(() => null),
    listResaSquashGroups().catch(() => null),
    getGroupMemberNames(bookingRuleId).catch(() => ({}) as Record<string, string>),
  ]);
  const whatsappGroupName = whatsappGroups?.find((g) => g.jid === current.whatsappGroupJid)?.name;
  const resaSquashGroupName = resaSquashGroups?.find((g) => g.groupId === current.resaSquashGroupId)?.label;

  const description = describeRuleInFrench(current, { whatsappGroupName, resaSquashGroupName, playerNames });
  await getDb().update(bookingRules).set({ description }).where(eq(bookingRules.id, bookingRuleId));
}

export async function toggleRuleEnabledAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id"));
  const enabled = formData.get("enabled") === "true";
  await getDb().update(bookingRules).set({ enabled }).where(eq(bookingRules.id, id));
  // Une seule règle active à la fois par groupe WhatsApp — activer celle-ci désactive les autres.
  if (enabled) {
    const [rule] = await getDb().select().from(bookingRules).where(eq(bookingRules.id, id));
    if (rule) {
      await getDb()
        .update(bookingRules)
        .set({ enabled: false })
        .where(and(eq(bookingRules.whatsappGroupJid, rule.whatsappGroupJid), ne(bookingRules.id, id)));
    }
  }
  await refreshRuleDescription(id);
  revalidatePath("/");
}

export async function deleteRuleAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id"));
  await getDb().delete(bookingRules).where(eq(bookingRules.id, id));
  revalidatePath("/");
}

/**
 * Appelée directement depuis un composant client (pas via <form action=...>) —
 * extraction LLM description → paramètres (ADR-015), aide à la saisie de règle.
 */
export async function generateRuleParamsAction(description: string): Promise<ExtractableRuleParams> {
  return generateRuleParams(description);
}

export async function upsertRuleAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const isNew = formData.get("isNew") === "true";
  const id = String(formData.get("id")).trim();

  if (!isNew && (await ruleHasScenarios(id))) {
    throw new Error(
      `Cette règle est utilisée par au moins un scénario de simulation — supprime-le(s) d'abord pour modifier la règle (voir /rules/${id}/simulator).`,
    );
  }

  const name = String(formData.get("name") ?? "").trim();

  const values = {
    id,
    name: name || null,
    whatsappGroupJid: String(formData.get("whatsappGroupJid")).trim(),
    resaSquashGroupId: String(formData.get("resaSquashGroupId")).trim(),
    pollCron: String(formData.get("pollCron")).trim(),
    decisionCron: String(formData.get("decisionCron")).trim(),
    targetWeekdayOffset: Number(formData.get("targetWeekdayOffset")),
    candidateStartTimes: parseCsv(String(formData.get("candidateStartTimes") ?? "")),
    maxCourtsPerSlot: Number(formData.get("maxCourtsPerSlot")),
    minPlayersPerCourt: Number(formData.get("minPlayersPerCourt")),
    maxPlayersPerCourt: Number(formData.get("maxPlayersPerCourt")),
    maxReservationsPerPlayer: Number(formData.get("maxReservationsPerPlayer")),
    priorityBookers: parseCsv(String(formData.get("priorityBookers") ?? "")),
    preferMinPlayersPerCourt: formData.get("preferMinPlayersPerCourt") === "on",
    courtPriority: parseCsv(String(formData.get("courtPriority") ?? "")).map(Number),
    availabilityWindowHours: Number(formData.get("availabilityWindowHours")),
    substituteBookers: parseCsv(String(formData.get("substituteBookers") ?? "")),
    maxDailyReservationsPerPlayer: Number(formData.get("maxDailyReservationsPerPlayer")),
    unexpectedPlayersMargin: Number(formData.get("unexpectedPlayersMargin") ?? 0),
  };

  if (isNew) {
    await getDb().insert(bookingRules).values({ ...values, enabled: false });
  } else {
    await getDb().update(bookingRules).set(values).where(eq(bookingRules.id, id));
  }
  await refreshRuleDescription(id);

  revalidatePath("/");
  redirect("/");
}

export async function createJobAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const ruleId = String(formData.get("ruleId"));
  const job = await createJob(ruleId);
  revalidatePath(`/rules/${ruleId}/events`);
  redirect(`/rules/${ruleId}/jobs/${job.id}`);
}

export async function editJobAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  const targetDate = String(formData.get("targetDate"));
  const candidateStartTimes = parseCsv(String(formData.get("candidateStartTimes") ?? ""));
  await editJob(ruleId, jobId, targetDate, candidateStartTimes);
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
}

export async function triggerSendPollAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  // Même form que editJobAction (un seul <form>, deux boutons) — sauvegarde d'abord
  // la date/les heures actuellement saisies avant d'envoyer le sondage, pour ne
  // jamais lancer avec des valeurs éditées mais jamais enregistrées.
  const targetDate = String(formData.get("targetDate"));
  const candidateStartTimes = parseCsv(String(formData.get("candidateStartTimes") ?? ""));
  await editJob(ruleId, jobId, targetDate, candidateStartTimes);
  await triggerJobAction(ruleId, jobId, "send-poll");
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
}

export async function triggerCollectVotesAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  await triggerJobAction(ruleId, jobId, "collect-votes");
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
}

export async function triggerRecollectVotesAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  await triggerJobAction(ruleId, jobId, "recollect-votes");
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
}

export async function triggerPlanAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  await triggerJobAction(ruleId, jobId, "plan");
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
}

export async function triggerRecomputePlanAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  await triggerJobAction(ruleId, jobId, "recompute-plan");
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
}

export async function triggerGoAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  // Case "dry-run" cochée par défaut (Pipeline.tsx) — absente du FormData si décochée.
  const realBooking = formData.get("dryRun") !== "on";
  await triggerJobAction(ruleId, jobId, "go", { realBooking });
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
}

export async function triggerRetryAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  await triggerJobAction(ruleId, jobId, "retry");
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
}

export async function cancelPollAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  await cancelPoll(ruleId, jobId);
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
  revalidatePath(`/rules/${ruleId}/events`);
}

function parseScenarioPlayers(formData: FormData): ScenarioPlayer[] {
  const raw = String(formData.get("playersJson") ?? "[]");
  return JSON.parse(raw) as ScenarioPlayer[];
}

export async function createScenarioAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const bookingRuleId = String(formData.get("bookingRuleId"));
  const name = String(formData.get("name") ?? "Nouveau scénario").trim();
  const input: CreateScenarioInput = { bookingRuleId, name, players: [] };
  const scenario = await createScenario(input);
  revalidatePath(`/rules/${bookingRuleId}/simulator`);
  redirect(`/rules/${bookingRuleId}/simulator/${scenario.id}`);
}

/**
 * Redirige vers la même page plutôt qu'un simple revalidatePath : ScenarioEditor garde
 * `players` en useState local (jamais resynchronisé depuis les props après un revalidate),
 * donc sans redirect l'affichage post-sauvegarde pouvait rester bloqué sur l'ancienne valeur
 * jusqu'à un rechargement manuel — le redirect force un remount avec les données fraîches.
 */
export async function saveScenarioAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const bookingRuleId = String(formData.get("bookingRuleId"));
  const scenarioId = String(formData.get("scenarioId"));
  const name = String(formData.get("name") ?? "").trim();
  const players = parseScenarioPlayers(formData);
  await updateScenario(scenarioId, { name, players, validated: null });
  revalidatePath(`/rules/${bookingRuleId}/simulator/${scenarioId}`);
  redirect(`/rules/${bookingRuleId}/simulator/${scenarioId}`);
}

export async function computeScenarioPlanAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const bookingRuleId = String(formData.get("bookingRuleId"));
  const scenarioId = String(formData.get("scenarioId"));
  await simulateScenario(bookingRuleId, scenarioId);
  revalidatePath(`/rules/${bookingRuleId}/simulator/${scenarioId}`);
}

export async function validateScenarioAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const bookingRuleId = String(formData.get("bookingRuleId"));
  const scenarioId = String(formData.get("scenarioId"));
  const validated = formData.get("validated") === "true";
  await updateScenario(scenarioId, { validated });
  revalidatePath(`/rules/${bookingRuleId}/simulator/${scenarioId}`);
}

export async function deleteScenarioAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const bookingRuleId = String(formData.get("bookingRuleId"));
  const scenarioId = String(formData.get("scenarioId"));
  await deleteScenario(scenarioId);
  revalidatePath(`/rules/${bookingRuleId}/simulator`);
  redirect(`/rules/${bookingRuleId}/simulator`);
}

export async function duplicateScenarioAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const bookingRuleId = String(formData.get("bookingRuleId"));
  const scenarioId = String(formData.get("scenarioId"));
  const copy = await duplicateScenario(bookingRuleId, scenarioId);
  revalidatePath(`/rules/${bookingRuleId}/simulator`);
  redirect(`/rules/${bookingRuleId}/simulator/${copy.id}`);
}

export async function saveVisibleGroupsAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const jids = formData.getAll("groupJids").map(String);
  await setVisibleWhatsappGroupJids(jids);
  revalidatePath("/");
  revalidatePath("/settings");
}
