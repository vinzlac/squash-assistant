import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface HuddleBotGroup {
  jid: string;
  name: string;
  isGroup: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

/** Découverte des groupes WhatsApp pour l'UI (activation par groupe) — voir docs/plan §2.6. */
export async function listHuddleBotGroups(): Promise<HuddleBotGroup[]> {
  const url = requireEnv("HUDDLE_BOT_MCP_URL");
  const apiKey = requireEnv("HUDDLE_BOT_MCP_API_KEY");

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client({ name: "squash-assistant-ui", version: "0.1.0" });
  await client.connect(transport);

  try {
    const result = await client.callTool({ name: "list_groups", arguments: {} });
    if (result.isError) {
      throw new Error(`list_groups a échoué : ${JSON.stringify(result.content)}`);
    }
    return (result.structuredContent as { groups: HuddleBotGroup[] }).groups;
  } finally {
    await client.close();
  }
}
