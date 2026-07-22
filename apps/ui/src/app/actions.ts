"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bookingRuleHistory, bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../lib/db";
import { cancelPoll, createJob, editJob, triggerJobAction } from "../lib/worker";

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Consigne l'état de la règle après une sauvegarde — historique consultable via /rules/[id]/history. */
async function recordRuleHistory(bookingRuleId: string): Promise<void> {
  const [current] = await getDb().select().from(bookingRules).where(eq(bookingRules.id, bookingRuleId));
  if (!current) return;
  await getDb().insert(bookingRuleHistory).values({ bookingRuleId, snapshot: current });
}

export async function toggleRuleEnabledAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  const enabled = formData.get("enabled") === "true";
  await getDb().update(bookingRules).set({ enabled }).where(eq(bookingRules.id, id));
  await recordRuleHistory(id);
  revalidatePath("/");
}

export async function deleteRuleAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  await getDb().delete(bookingRules).where(eq(bookingRules.id, id));
  revalidatePath("/");
}

export async function upsertRuleAction(formData: FormData): Promise<void> {
  const isNew = formData.get("isNew") === "true";
  const id = String(formData.get("id")).trim();

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
  };

  if (isNew) {
    await getDb().insert(bookingRules).values({ ...values, enabled: false });
  } else {
    await getDb().update(bookingRules).set(values).where(eq(bookingRules.id, id));
  }
  await recordRuleHistory(id);

  revalidatePath("/");
  redirect("/");
}

export async function createJobAction(formData: FormData): Promise<void> {
  const ruleId = String(formData.get("ruleId"));
  const job = await createJob(ruleId);
  revalidatePath(`/rules/${ruleId}/events`);
  redirect(`/rules/${ruleId}/jobs/${job.id}`);
}

export async function editJobAction(formData: FormData): Promise<void> {
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  const targetDate = String(formData.get("targetDate"));
  const candidateStartTimes = parseCsv(String(formData.get("candidateStartTimes") ?? ""));
  await editJob(ruleId, jobId, targetDate, candidateStartTimes);
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
}

export async function triggerSendPollAction(formData: FormData): Promise<void> {
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
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  await triggerJobAction(ruleId, jobId, "collect-votes");
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
}

export async function triggerRecollectVotesAction(formData: FormData): Promise<void> {
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  await triggerJobAction(ruleId, jobId, "recollect-votes");
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
}

export async function triggerPlanAction(formData: FormData): Promise<void> {
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  await triggerJobAction(ruleId, jobId, "plan");
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
}

export async function triggerGoAction(formData: FormData): Promise<void> {
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  // Case "dry-run" cochée par défaut (Pipeline.tsx) — absente du FormData si décochée.
  const realBooking = formData.get("dryRun") !== "on";
  await triggerJobAction(ruleId, jobId, "go", { realBooking });
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
}

export async function triggerRetryAction(formData: FormData): Promise<void> {
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  await triggerJobAction(ruleId, jobId, "retry");
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
}

export async function cancelPollAction(formData: FormData): Promise<void> {
  const ruleId = String(formData.get("ruleId"));
  const jobId = String(formData.get("jobId"));
  await cancelPoll(ruleId, jobId);
  revalidatePath(`/rules/${ruleId}/jobs/${jobId}`);
  revalidatePath(`/rules/${ruleId}/events`);
}
