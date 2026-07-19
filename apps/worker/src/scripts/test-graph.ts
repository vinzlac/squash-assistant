import { Command, MemorySaver } from "@langchain/langgraph";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { JobRun } from "@squash-assistant/db/schema";
import { buildPipelineGraph } from "../graph/buildGraph.js";
import { getJobExecutionStatus } from "../scheduler/scheduler.js";
import type { BookingRule } from "../config.js";
import type { Database } from "@squash-assistant/db/client";

/**
 * Validation Phase 2 (docs/plan/squash-assistant-poc.md §7) : pipeline complet
 * SendPoll → CollectVotes → BookSlots → Announce sur des mocks MCP/Telegram,
 * sans dépendre d'un vrai groupe WhatsApp ni des vraies API. Exercice aussi
 * les deux pauses interrupt() (fenêtre de décision, confirmation "go") et
 * l'ordre de priorité des réservataires (priorityBookers).
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

const toolCalls: Array<{ name: string; args: unknown }> = [];

function mockClient(handlers: Record<string, unknown>): Client {
  return {
    callTool: async ({ name, arguments: args }: { name: string; arguments: unknown }) => {
      toolCalls.push({ name, args });
      if (!(name in handlers)) {
        throw new Error(`Tool mock manquant pour "${name}"`);
      }
      const handler = handlers[name];
      const structuredContent = typeof handler === "function" ? await handler(args) : handler;
      return { structuredContent, isError: false };
    },
  } as unknown as Client;
}

const huddleBotClient = mockClient({
  ask_poll: { requestId: "test-request-1" },
  get_responses: {
    requestId: "test-request-1",
    // Bob répond avant Alice, mais Alice est priorityBooker → doit passer en tête.
    responses: [
      { member: "Bob", phone: "33687654321", statut: "oui" },
      { member: "Alice", phone: "33612345678", statut: "oui" },
      { member: "Carla", phone: "33611112222", statut: "non" },
    ],
  },
  send_message: {},
});

const resaSquashClient = mockClient({
  lookup_player_by_phone: async (args: { phone: string }) => ({
    found: true,
    userId: args.phone === "+33612345678" ? "user-alice" : "user-bob",
  }),
  plan_group_bookings: {
    proposedBookings: [
      { sessionId: "s1", court: 2, slotTime: "18:45:00", slotEndTime: "19:30:00", userId: "user-alice", partnerId: "user-bob" },
      { sessionId: "s2", court: 2, slotTime: "19:30:00", slotEndTime: "20:15:00", userId: "user-alice", partnerId: "user-bob" },
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

const emittedEvents: Array<{ type: string; status: string; targetDate: string; detail: unknown }> = [];
const mockDb = {
  insert: () => ({
    values: async (data: { type: string; status: string; targetDate: string; detail: unknown }) => {
      emittedEvents.push(data);
      return [];
    },
  }),
  // setJobRunPollInfo (sendPoll.ts) — pas utile à la validation du graphe, no-op suffit.
  update: () => ({
    set: () => ({
      where: () => ({
        returning: async () => [],
      }),
    }),
  }),
} as unknown as Database;

const bookingRule: BookingRule = {
  id: "test-group",
  enabled: true,
  whatsappGroupJid: "test@g.us",
  resaSquashGroupId: "test-group-id",
  pollCron: "0 10 * * 2",
  decisionCron: "30 21 * * 2",
  targetWeekdayOffset: 7,
  sessionStartTime: "18H45",
  maxCourtsPerSlot: 1,
  minPlayersPerCourt: 2,
  maxPlayersPerCourt: 2,
  maxReservationsPerPlayer: 2,
  priorityBookers: ["user-alice"],
  preferMinPlayersPerCourt: true,
  courtPriority: [2, 1],
};

async function main(): Promise<void> {
  const checkpointer = new MemorySaver();
  const graph = buildPipelineGraph(
    {
      huddleBot: { client: huddleBotClient, close: async () => {} },
      resaSquash: { client: resaSquashClient, close: async () => {} },
      telegram: { botToken: "mock-token", chatId: "mock-chat" },
      db: mockDb,
    },
    checkpointer,
  );

  // "${bookingRule.id}:${jobId}" — même convention que threadIdForJob (jobRuns.ts),
  // pour que getJobExecutionStatus (utilisé plus bas) retrouve le bon thread.
  const jobId = "test-job-1";
  const config = { configurable: { thread_id: `${bookingRule.id}:${jobId}` } };

  console.log("--- 1. SendPoll (cron du matin) ---");
  const r1 = await graph.invoke({ bookingRule, targetDate: "2026-07-20" }, config);
  assertInterrupted(r1, "await-decision-window");

  console.log("--- 2. CollectVotes (cron du soir, action 1/2) ---");
  const r2 = await graph.invoke(new Command({ resume: true }), config);
  assertInterrupted(r2, "await-plan-trigger");

  console.log('--- 2ter. triggerRecollectVotes : Carla change son vote en "oui" (simulé) ---');
  // Valide seulement le mécanisme updateState(..., "collectVotes") utilisé par
  // triggerRecollectVotes (scheduler.ts) — resolveVotes() lui-même est déjà
  // exercé par le passage CollectVotes ci-dessus, pas la peine de le remocker ici.
  const beforeRecollect = await graph.getState(config);
  const recollected = [...((beforeRecollect.values.confirmedPlayerIds as string[]) ?? []), "user-carla"];
  await graph.updateState(config, { confirmedPlayerIds: recollected }, "waitForPlanTrigger");
  const afterRecollect = await graph.getState(config);
  if (afterRecollect.next?.[0] !== "bookSlots") {
    throw new Error(`Échec : updateState a déplacé le point de pause (next=${JSON.stringify(afterRecollect.next)}).`);
  }
  if (JSON.stringify(afterRecollect.values.confirmedPlayerIds) !== JSON.stringify(recollected)) {
    throw new Error(`Échec : confirmedPlayerIds pas mis à jour après updateState.`);
  }
  // Vérifie via le vrai chemin de lecture de l'UI (getJobExecutionStatus), pas
  // juste le `next` brut — c'est justement ce contrôle qui manquait et qui a
  // laissé passer un bug en prod : next=["bookSlots"] (nœud réel, pas une
  // barrière) n'était pas reconnu par pausedOnFromSnapshot et retombait sur
  // stage "error" au lieu de "awaiting-plan".
  const job = { id: jobId, targetDate: "2026-07-20" } as JobRun;
  const statusAfterRecollect = await getJobExecutionStatus(bookingRule, job, graph);
  if (statusAfterRecollect.stage !== "awaiting-plan") {
    throw new Error(`Échec : stage attendu "awaiting-plan" après recollect, reçu "${statusAfterRecollect.stage}".`);
  }
  console.log(`✓ confirmedPlayerIds mis à jour (${recollected.length}) sans déplacer le point de pause`);

  console.log("--- 2bis. BookSlots (cron du soir, action 2/2) ---");
  const r2bis = await graph.invoke(new Command({ resume: true }), config);
  assertInterrupted(r2bis, "await-go");

  const planCall = toolCalls.find((c) => c.name === "plan_group_bookings");
  const orderedIds = (planCall?.args as { expectedPlayerIds: string[] } | undefined)?.expectedPlayerIds;
  if (orderedIds?.[0] !== "user-alice") {
    throw new Error(`Échec : priorityBookers non respecté, expectedPlayerIds = ${JSON.stringify(orderedIds)}`);
  }
  console.log('✓ priorityBookers respecté (Alice en tête malgré la réponse de Bob en premier)');
  const slotsPerPlayer = (planCall?.args as { slotsPerPlayer: number } | undefined)?.slotsPerPlayer;
  if (slotsPerPlayer !== bookingRule.maxReservationsPerPlayer) {
    throw new Error(`Échec : slotsPerPlayer=${slotsPerPlayer} attendu ${bookingRule.maxReservationsPerPlayer}`);
  }
  console.log("✓ maxReservationsPerPlayer transmis comme slotsPerPlayer");

  console.log("--- 3. Confirmation \"go\" → Announce ---");
  await graph.invoke(new Command({ resume: "go" }), config);

  console.log("--- Messages Telegram capturés ---");
  telegramMessages.forEach((msg, i) => console.log(`[${i}]`, msg));

  const announceMessage = telegramMessages.find((m) => m.includes("Annonce envoyée"));
  if (!announceMessage) {
    throw new Error("Échec : l'annonce finale n'a pas été loguée sur Telegram.");
  }

  console.log("--- Events applicatifs capturés (booking_rules.events) ---");
  emittedEvents.forEach((e, i) => console.log(`[${i}] ${e.type}/${e.status}`, JSON.stringify(e.detail)));
  const eventTypes = emittedEvents.map((e) => e.type);
  if (JSON.stringify(eventTypes) !== JSON.stringify(["poll", "collect_votes", "booking", "booking"])) {
    throw new Error(`Échec : séquence d'events inattendue : ${JSON.stringify(eventTypes)}`);
  }
  if (emittedEvents.some((e) => e.status !== "success")) {
    throw new Error("Échec : un event a un statut différent de success.");
  }
  console.log("✓ 4 events applicatifs loggués (poll, collect_votes, booking×2) tous en success");

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
