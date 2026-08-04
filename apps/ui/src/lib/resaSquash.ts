import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface ResaSquashGroup {
  groupId: string;
  label: string;
}

export interface ResaSquashGroupMember {
  user_id: string;
  first_name: string;
  last_name: string;
  phone?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

async function withResaClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const url = requireEnv("RESA_SQUASH_MCP_URL");
  const apiKey = requireEnv("RESA_SQUASH_MCP_API_KEY");

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client({ name: "squash-assistant-ui", version: "0.1.0" });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Découverte des groupes resa-squash pour l'UI (affichage du libellé à côté du groupId) — voir docs/plan §2.6. */
export async function listResaSquashGroups(): Promise<ResaSquashGroup[]> {
  return withResaClient(async (client) => {
    const result = await client.callTool({ name: "list_my_groups", arguments: {} });
    if (result.isError) {
      throw new Error(`list_my_groups a échoué : ${JSON.stringify(result.content)}`);
    }
    return (result.structuredContent as { groups: ResaSquashGroup[] }).groups;
  });
}

/** Membres de plusieurs groupes resa-squash (une seule connexion MCP). */
export async function listResaSquashMembersForGroups(
  groupIds: string[],
): Promise<ResaSquashGroupMember[]> {
  const unique = [...new Set(groupIds.filter(Boolean))];
  if (unique.length === 0) return [];

  return withResaClient(async (client) => {
    const all: ResaSquashGroupMember[] = [];
    for (const groupId of unique) {
      const result = await client.callTool({
        name: "list_group_members",
        arguments: { groupId, includePhones: true },
      });
      if (result.isError) {
        throw new Error(`list_group_members(${groupId}) a échoué : ${JSON.stringify(result.content)}`);
      }
      const members = (result.structuredContent as { members: ResaSquashGroupMember[] }).members;
      all.push(...members);
    }
    return all;
  });
}

/** Membres d'un groupe resa-squash (avec téléphones pour corrélation WhatsApp). */
export async function listResaSquashGroupMembers(groupId: string): Promise<ResaSquashGroupMember[]> {
  return listResaSquashMembersForGroups([groupId]);
}
