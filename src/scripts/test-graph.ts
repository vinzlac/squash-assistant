import { Command, MemorySaver } from "@langchain/langgraph";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildPipelineGraph } from "../graph/buildGraph.js";
import type { GroupConfig } from "../config.js";

/**
 * Validation Phase 2 (docs/plan/squash-assistant-poc.md §7) : pipeline complet
 * SendPoll → CollectVotes → BookSlots → Announce sur des mocks MCP/Telegram,
 * sans dépendre d'un vrai groupe WhatsApp ni des vraies API. Exercice aussi
 * les deux pauses interrupt() (fenêtre de décision, confirmation "go").
 */

const telegramMessages: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("api.telegram.org")) {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body.text) {
      telegramMessages.push(body.text);
    }
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
  }
  return originalFetch(input, init);
}) as typeof fetch;

function mockClient(handlers: Record<string, unknown>): Client {
  return {
    callTool: async ({ name }: { name: string }) => {
      if (!(name in handlers)) {
        throw new Error(`Tool mock manquant pour "${name}"`);
      }
      return { structuredContent: handlers[name], isError: false };
    },
  } as unknown as Client;
}

const huddleBotClient = mockClient({
  ask_poll: { requestId: "test-request-1" },
  get_responses: {
    requestId: "test-request-1",
    responses: [
      { jid: "33612345678@s.whatsapp.net", name: "Alice", status: "oui" },
      { jid: "33687654321@s.whatsapp.net", name: "Bob", status: "oui" },
      { jid: "33611112222@s.whatsapp.net", name: "Carla", status: "non" },
    ],
  },
  send_message: {},
});

const resaSquashClient = mockClient({
  lookup_player_by_phone: { found: true, userId: "user-mock" },
  plan_group_bookings: {
    proposedBookings: [
      { sessionId: "s1", court: 2, beginTime: "18:45:00", endTime: "19:30:00", players: ["Alice", "Bob"] },
      { sessionId: "s2", court: 2, beginTime: "19:30:00", endTime: "20:15:00", players: ["Alice", "Bob"] },
    ],
    warnings: [],
    meta: {
      courtsNeeded: 1,
      roundsPlanned: 2,
      dryRun: true,
      groupLabel: "test",
      recurringWeekday: 2,
      recurringStartTime: "18:45:00",
      slotsPerPlayer: 2,
      groupMinSlotsPerPlayer: 2,
      groupMaxSlotsPerPlayer: 3,
      pairCount: 1,
    },
    dryRun: true,
  },
});

const groupConfig: GroupConfig = {
  id: "test-group",
  enabled: true,
  whatsappGroupJid: "test@g.us",
  resaSquashGroupId: "test-group-id",
  pollCron: "0 10 * * 2",
  decisionCron: "30 21 * * 2",
  targetWeekdayOffset: 7,
  slotStartTimes: [{ court: 2, beginTime: "18H45" }],
};

async function main(): Promise<void> {
  const checkpointer = new MemorySaver();
  const graph = buildPipelineGraph(
    {
      huddleBot: { client: huddleBotClient, close: async () => {} },
      resaSquash: { client: resaSquashClient, close: async () => {} },
      telegram: { botToken: "mock-token", chatId: "mock-chat" },
    },
    checkpointer,
  );

  const config = { configurable: { thread_id: "test-thread-1" } };

  console.log("--- 1. SendPoll (cron du matin) ---");
  const r1 = await graph.invoke({ groupConfig, targetDate: "2026-07-20" }, config);
  assertInterrupted(r1, "await-decision-window");

  console.log("--- 2. CollectVotes → BookSlots (cron du soir) ---");
  const r2 = await graph.invoke(new Command({ resume: true }), config);
  assertInterrupted(r2, "await-go");

  console.log("--- 3. Confirmation \"go\" → Announce ---");
  const r3 = await graph.invoke(new Command({ resume: "go" }), config);
  console.log("état final :", JSON.stringify(r3, null, 2));

  console.log("--- Messages Telegram capturés ---");
  telegramMessages.forEach((msg, i) => console.log(`[${i}]`, msg));

  const announceMessage = telegramMessages.find((m) => m.includes("Annonce envoyée"));
  if (!announceMessage) {
    throw new Error("Échec : l'annonce finale n'a pas été loguée sur Telegram.");
  }

  console.log("\n✅ Pipeline complet validé (mocks).");
  globalThis.fetch = originalFetch;
}

function assertInterrupted(result: unknown, expectedType: string): void {
  const interrupts = (result as { __interrupt__?: Array<{ value?: { type?: string } }> }).__interrupt__;
  const matches = interrupts?.some((i) => i.value?.type === expectedType);
  if (!matches) {
    throw new Error(`Échec : interrupt "${expectedType}" attendu, reçu ${JSON.stringify(interrupts)}`);
  }
  console.log(`✓ interrompu comme attendu sur "${expectedType}"`);
}

main().catch((err) => {
  globalThis.fetch = originalFetch;
  console.error("[test-graph] erreur :", err);
  process.exit(1);
});
