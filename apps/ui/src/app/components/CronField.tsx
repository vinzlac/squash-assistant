"use client";

import { useState } from "react";

const DOW_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

/** Traduit une expression cron 5 champs (min heure jourDuMois mois jourDeLaSemaine) en phrase lisible — se limite aux formes utilisées par ce projet (heure fixe, `*` sur jour du mois/mois), repli sur l'expression brute sinon. */
export function describeCron(expr: string): string {
  const trimmed = expr.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return `Cron : "${trimmed}"`;

  const [min, hour, dom, month, dow] = parts;
  if (dom !== "*" || month !== "*") return `Cron : "${trimmed}" (jour du mois/mois non standard)`;

  const minute = Number(min);
  const h = Number(hour);
  if (!Number.isInteger(minute) || !Number.isInteger(h) || minute < 0 || minute > 59 || h < 0 || h > 23) {
    return `Cron : "${trimmed}"`;
  }
  const time = `${String(h).padStart(2, "0")}h${String(minute).padStart(2, "0")}`;

  if (dow === "*") return `Tous les jours à ${time}`;

  const days = dow.split(",").map((d) => DOW_FR[Number(d)]);
  if (days.some((d) => !d)) return `Cron : "${trimmed}"`;
  return `Tous les ${days.map((d) => `${d}s`).join(", ")} à ${time}`;
}

interface Props {
  name: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
}

export function CronField({ name, label, defaultValue, placeholder }: Props) {
  const [value, setValue] = useState(defaultValue ?? "");

  return (
    <label>
      {label}
      <input
        type="text"
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        required
      />
      <div className="muted" style={{ fontSize: "0.8rem" }}>
        {describeCron(value)}
      </div>
    </label>
  );
}
