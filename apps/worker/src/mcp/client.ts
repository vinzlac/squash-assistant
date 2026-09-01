import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpConnection {
  client: Client;
  close: () => Promise<void>;
}

export async function connectMcpClient(
  name: string,
  url: string,
  apiKey: string,
): Promise<McpConnection> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  });
  const client = new Client({ name: `squash-assistant-${name}`, version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    close: () => client.close(),
  };
}

/**
 * Échec d'un tool MCP. `reason` est le code métier stable renvoyé par resa-squash quand il
 * refuse (`PLAYER_NOT_REGISTERED`, `PLAYER_BOOKING_LIMIT_REACHED`, `SLOT_ALREADY_BOOKED`,
 * `TEAMR_BOOKING_REJECTED` — voir resa-squash ADR-011), `null` pour un échec non qualifié.
 * C'est ce code, pas le texte du message, qui pilote la substitution par le joker (ADR-024).
 */
export class McpToolError extends Error {
  constructor(
    readonly toolName: string,
    readonly reason: string | null,
    readonly details: Record<string, unknown>,
    message: string,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

/**
 * Un tool en erreur renvoie `content: [{ text: message }, { text: JSON du payload }]` — le
 * payload porte `reason` / `details`. On parcourt les blocs texte et on retient le premier
 * JSON exploitable ; un serveur qui ne renverrait rien de tel donne simplement `reason: null`.
 */
function parseToolErrorPayload(content: unknown): Record<string, unknown> {
  if (!Array.isArray(content)) return {};
  for (const block of content) {
    const text = (block as { type?: string; text?: unknown })?.text;
    if (typeof text !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Bloc de texte libre (le résumé lisible) : on continue avec le suivant.
    }
  }
  return {};
}

export async function callTool<T = unknown>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const payload = parseToolErrorPayload(result.content);
    const reason = typeof payload.reason === "string" ? payload.reason : null;
    const details =
      payload.details && typeof payload.details === "object" && !Array.isArray(payload.details)
        ? (payload.details as Record<string, unknown>)
        : {};
    throw new McpToolError(
      name,
      reason,
      details,
      `MCP tool "${name}" a échoué : ${JSON.stringify(result.content)}`,
    );
  }
  return result.structuredContent as T;
}
