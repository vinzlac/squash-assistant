import { readFile } from "node:fs/promises";
import type { GroupConfig } from "./config.js";

export async function loadGroupConfigs(path = "groups.json"): Promise<GroupConfig[]> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as GroupConfig[];
}
