import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface ResaSquashGroup {
  groupId: string;
  label: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

/** Découverte des groupes resa-squash pour l'UI (affichage du libellé à côté du groupId) — voir docs/plan §2.6. */
export async function listResaSquashGroups(): Promise<ResaSquashGroup[]> {
  const url = requireEnv("RESA_SQUASH_MCP_URL");
  const apiKey = requireEnv("RESA_SQUASH_MCP_API_KEY");

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client({ name: "squash-assistant-ui", version: "0.1.0" });
  await client.connect(transport);

  try {
    const result = await client.callTool({ name: "list_my_groups", arguments: {} });
    if (result.isError) {
      throw new Error(`list_my_groups a échoué : ${JSON.stringify(result.content)}`);
    }
    return (result.structuredContent as { groups: ResaSquashGroup[] }).groups;
  } finally {
    await client.close();
  }
}
