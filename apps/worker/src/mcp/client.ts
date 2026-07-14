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

export async function callTool<T = unknown>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`MCP tool "${name}" a échoué : ${JSON.stringify(result.content)}`);
  }
  return result.structuredContent as T;
}
