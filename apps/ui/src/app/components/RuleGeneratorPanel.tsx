"use client";

import { useState, useTransition, type MouseEvent } from "react";
import type { BookingRule } from "@squash-assistant/db/schema";
import { describeRuleInFrench } from "@squash-assistant/db/ruleDescription";
import { generateRuleParamsAction } from "../actions";
import type { ExtractableRuleParams } from "../../lib/worker";

interface Props {
  /** Non éditable dans RuleForm (activation gérée depuis les pages liste) — nécessaire pour reconstruire un BookingRule complet côté "paramètres → texte". */
  enabled: boolean;
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Lit l'état courant (non sauvegardé) du formulaire — fonctionne même sur des champs non contrôlés (defaultValue). */
function buildRuleFromForm(form: HTMLFormElement, enabled: boolean): BookingRule {
  const data = new FormData(form);
  const str = (name: string) => String(data.get(name) ?? "");
  return {
    id: str("id"),
    name: str("name") || null,
    enabled,
    whatsappGroupJid: str("whatsappGroupJid"),
    resaSquashGroupId: str("resaSquashGroupId"),
    pollCron: str("pollCron"),
    decisionCron: str("decisionCron"),
    targetWeekdayOffset: Number(str("targetWeekdayOffset")),
    candidateStartTimes: parseCsv(str("candidateStartTimes")),
    maxCourtsPerSlot: Number(str("maxCourtsPerSlot")),
    minPlayersPerCourt: Number(str("minPlayersPerCourt")),
    maxPlayersPerCourt: Number(str("maxPlayersPerCourt")),
    maxReservationsPerPlayer: Number(str("maxReservationsPerPlayer")),
    priorityBookers: parseCsv(str("priorityBookers")),
    preferMinPlayersPerCourt: data.get("preferMinPlayersPerCourt") === "on",
    courtPriority: parseCsv(str("courtPriority")).map(Number),
    availabilityWindowHours: Number(str("availabilityWindowHours")),
  };
}

/** Écrit les paramètres extraits directement dans les champs (non contrôlés) du formulaire. */
function applyParamsToForm(form: HTMLFormElement, params: ExtractableRuleParams): void {
  const setValue = (name: string, value: string) => {
    const el = form.elements.namedItem(name);
    if (el instanceof HTMLInputElement) el.value = value;
  };
  setValue("candidateStartTimes", params.candidateStartTimes.join(", "));
  setValue("pollCron", params.pollCron);
  setValue("decisionCron", params.decisionCron);
  setValue("targetWeekdayOffset", String(params.targetWeekdayOffset));
  setValue("maxCourtsPerSlot", String(params.maxCourtsPerSlot));
  setValue("minPlayersPerCourt", String(params.minPlayersPerCourt));
  setValue("maxPlayersPerCourt", String(params.maxPlayersPerCourt));
  setValue("maxReservationsPerPlayer", String(params.maxReservationsPerPlayer));
  setValue("priorityBookers", params.priorityBookers.join(", "));
  setValue("courtPriority", params.courtPriority.join(", "));
  setValue("availabilityWindowHours", String(params.availabilityWindowHours));
  const checkbox = form.elements.namedItem("preferMinPlayersPerCourt");
  if (checkbox instanceof HTMLInputElement) checkbox.checked = params.preferMinPlayersPerCourt;
}

/**
 * Panneau de génération assistée (ADR-015) — deux sens :
 * - texte → paramètres : appel LLM (Anthropic Claude), écrit directement dans les champs du formulaire.
 * - paramètres → texte : déterministe (describeRuleInFrench), aucun appel réseau, lit l'état courant du formulaire.
 * Ne sauvegarde jamais rien — seulement une aide à la saisie avant de cliquer "Créer"/"Enregistrer".
 */
export function RuleGeneratorPanel({ enabled }: Props) {
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleGenerateParams(event: MouseEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    if (!form) return;
    setError(null);
    startTransition(async () => {
      try {
        const params = await generateRuleParamsAction(description);
        applyParamsToForm(form, params);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Erreur inconnue lors de la génération.");
      }
    });
  }

  function handleGenerateDescription(event: MouseEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    if (!form) return;
    setError(null);
    const rule = buildRuleFromForm(form, enabled);
    setDescription(describeRuleInFrench(rule));
  }

  return (
    <div
      style={{
        gridColumn: "1 / -1",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        padding: "1rem",
        marginBottom: "1rem",
      }}
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Génération assistée (Claude) — texte ↔ paramètres, ne sauvegarde rien tant que tu ne cliques pas sur
        « Créer »/« Enregistrer ».
      </p>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={6}
        style={{ width: "100%", font: "inherit" }}
        placeholder="Décris la règle en français (jours, heures, joueurs par court, priorités...)"
      />
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
        <button type="button" onClick={handleGenerateParams} disabled={isPending || !description.trim()}>
          {isPending ? "Génération..." : "Générer les paramètres à partir du texte"}
        </button>
        <button type="button" onClick={handleGenerateDescription}>
          Générer la description à partir des paramètres actuels
        </button>
      </div>
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
    </div>
  );
}
