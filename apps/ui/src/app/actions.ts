"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bookingRules } from "@squash-assistant/db/schema";
import { getDb } from "../lib/db";
import { triggerNewRun, triggerWorkerAction } from "../lib/worker";

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export async function toggleRuleEnabledAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  const enabled = formData.get("enabled") === "true";
  await getDb().update(bookingRules).set({ enabled }).where(eq(bookingRules.id, id));
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

  const values = {
    id,
    whatsappGroupJid: String(formData.get("whatsappGroupJid")).trim(),
    resaSquashGroupId: String(formData.get("resaSquashGroupId")).trim(),
    pollCron: String(formData.get("pollCron")).trim(),
    decisionCron: String(formData.get("decisionCron")).trim(),
    targetWeekdayOffset: Number(formData.get("targetWeekdayOffset")),
    sessionStartTime: String(formData.get("sessionStartTime")).trim(),
    maxCourtsPerSlot: Number(formData.get("maxCourtsPerSlot")),
    minPlayersPerCourt: Number(formData.get("minPlayersPerCourt")),
    maxPlayersPerCourt: Number(formData.get("maxPlayersPerCourt")),
    maxReservationsPerPlayer: Number(formData.get("maxReservationsPerPlayer")),
    priorityBookers: parseCsv(String(formData.get("priorityBookers") ?? "")),
    preferMinPlayersPerCourt: formData.get("preferMinPlayersPerCourt") === "on",
    courtPriority: parseCsv(String(formData.get("courtPriority") ?? "")).map(Number),
  };

  if (isNew) {
    await getDb().insert(bookingRules).values({ ...values, enabled: false });
  } else {
    await getDb().update(bookingRules).set(values).where(eq(bookingRules.id, id));
  }

  revalidatePath("/");
  redirect("/");
}

export async function triggerSendPollAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  await triggerWorkerAction(id, "send-poll");
  revalidatePath(`/rules/${id}/events`);
}

export async function triggerDecisionAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  await triggerWorkerAction(id, "decision");
  revalidatePath(`/rules/${id}/events`);
}

export async function triggerGoAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  await triggerWorkerAction(id, "go");
  revalidatePath(`/rules/${id}/events`);
}

export async function triggerNewRunAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id"));
  await triggerNewRun(id);
  revalidatePath(`/rules/${id}/events`);
}
