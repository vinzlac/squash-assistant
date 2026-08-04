import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "./config.js";

const REQUIRED = [
  "NATS_URL",
  "NATS_USER",
  "NATS_PASSWORD",
  "VINCENT_ALL_GROUP_JID",
  "HUDDLE_BOT_MCP_URL",
  "HUDDLE_BOT_MCP_API_KEY",
  "DATABASE_URL",
] as const;

describe("loadEnv", () => {
  afterEach(() => {
    for (const k of REQUIRED) delete process.env[k];
    delete process.env.ALLOWLIST_REFRESH_MS;
    delete process.env.HEALTH_PORT;
  });

  it("charge les variables requises", () => {
    process.env.NATS_URL = "nats://nats:4222";
    process.env.NATS_USER = "whatsapp-consumers";
    process.env.NATS_PASSWORD = "secret";
    process.env.VINCENT_ALL_GROUP_JID = "120363424956785709@g.us";
    process.env.HUDDLE_BOT_MCP_URL = "https://huddle-bot.example/api/mcp";
    process.env.HUDDLE_BOT_MCP_API_KEY = "sk_live_x";
    process.env.DATABASE_URL = "postgres://u:p@localhost/db";
    const env = loadEnv();
    expect(env.vincentAllGroupJid).toBe("120363424956785709@g.us");
    expect(env.allowlistRefreshMs).toBe(60_000);
    expect(env.healthPort).toBe(8081);
  });

  it("échoue si une variable manque", () => {
    expect(() => loadEnv()).toThrow(/NATS_URL/);
  });
});
