import { beforeEach, describe, expect, it, vi } from "vitest";

const connect = vi.fn();
const callTool = vi.fn();
const close = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(function () {
    return { connect, callTool, close };
  }),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(function () {
    return {};
  }),
}));

import { HUDDLE_BOT_TIMEOUT_MS, listHuddleBotGroups } from "./huddleBot";

describe("listHuddleBotGroups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HUDDLE_BOT_MCP_URL = "https://huddle-bot.example/api/mcp";
    process.env.HUDDLE_BOT_MCP_API_KEY = "sk_test";
    connect.mockResolvedValue(undefined);
    close.mockResolvedValue(undefined);
  });

  it("borne la connexion et l'appel list_groups à 3 s (le défaut du SDK est 60 s)", async () => {
    callTool.mockResolvedValue({ structuredContent: { groups: [] } });

    await listHuddleBotGroups();

    expect(HUDDLE_BOT_TIMEOUT_MS).toBe(3000);
    expect(connect).toHaveBeenCalledWith(expect.anything(), { timeout: 3000 });
    expect(callTool).toHaveBeenCalledWith({ name: "list_groups", arguments: {} }, undefined, { timeout: 3000 });
  });

  it("rejette et ferme le client quand huddle-bot ne répond pas à temps", async () => {
    callTool.mockRejectedValue(new Error("Request timed out"));

    await expect(listHuddleBotGroups()).rejects.toThrow("Request timed out");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("retourne les groupes quand huddle-bot répond", async () => {
    const groups = [{ jid: "1@g.us", name: "Squash", isGroup: true }];
    callTool.mockResolvedValue({ structuredContent: { groups } });

    await expect(listHuddleBotGroups()).resolves.toEqual(groups);
  });
});
