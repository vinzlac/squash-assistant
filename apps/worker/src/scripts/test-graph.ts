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
    // Carla choisit une heure différente (19H30) — groupe distinct, effectif
    // insuffisant tant que Dave ne vote pas (voir triggerRecollectVotes plus bas).
    responses: [
      { member: "Bob", phone: "33687654321", statut: "18H45" },
      { member: "Alice", phone: "33612345678", statut: "18H45" },
      { member: "Carla", phone: "33611112222", statut: "19H30" },
    ],
  },
  send_message: {},
});

const PHONE_TO_USER_ID: Record<string, string> = {
  "+33612345678": "user-alice",
  "+33687654321": "user-bob",
  "+33611112222": "user-carla",
  "+33611113333": "user-dave",
};

/** groupId dédié au scénario 3 (escalade capacité + fenêtre) — isole son plan_group_bookings des autres scénarios. */
const CAPACITY_GROUP_ID = "test-capacity-group-id";
let capacityPlanCallCount = 0;

const resaSquashClient = mockClient({
  lookup_player_by_phone: async (args: { phone: string }) => ({
    found: true,
    userId: PHONE_TO_USER_ID[args.phone],
  }),
  // Un plan minimal par appel, tagué avec le startTime demandé — suffit à
  // valider le routage par groupe d'heure (agrégation côté bookSlots.ts),
  // pas l'algo de pairing/vagues lui-même (déjà testé côté resa-squash).
  plan_group_bookings: async (args: {
    startTime: string;
    expectedPlayerIds: string[];
    groupId: string;
    preferMinPlayersPerCourt?: boolean;
  }) => {
    if (args.groupId === CAPACITY_GROUP_ID) {
      capacityPlanCallCount += 1;
      const meta = {
        courtsNeeded: 3,
        roundsPlanned: 1,
        dryRun: true,
        groupLabel: "capacity-test",
        recurringWeekday: 2,
        recurringStartTime: args.startTime,
        slotsPerPlayer: 1,
        groupMinSlotsPerPlayer: 2,
        groupMaxSlotsPerPlayer: 3,
        pairCount: 3, // 6 joueurs confirmés → objectif 3 réservations (1 par paire).
      };
      if (args.preferMinPlayersPerCourt !== false) {
        // 1er appel (min-fill, comportement configuré) : capacité insuffisante, 1 seule paire casée sur 3.
        return {
          proposedBookings: [
            {
              sessionId: "cap-s1",
              court: 1,
              slotTime: "15H00",
              slotEndTime: "15H45",
              userId: args.expectedPlayerIds[0],
              partnerId: args.expectedPlayerIds[1],
              startDate: "2026-07-20T15:00:00+02:00",
              groupId: CAPACITY_GROUP_ID,
            },
          ],
          warnings: ["Couche 1/1 : 2 paire(s) non placée(s) — pas assez de courts."],
          meta,
          dryRun: true,
        };
      }
      // Escalade (max-fill) : 3 courts trouvés — 2 dans la fenêtre (15H00), 1 hors fenêtre (17H00, > 15H00+1h).
      return {
        proposedBookings: [
          {
            sessionId: "cap-s1",
            court: 1,
            slotTime: "15H00",
            slotEndTime: "15H45",
            userId: args.expectedPlayerIds[0],
            partnerId: args.expectedPlayerIds[1],
            startDate: "2026-07-20T15:00:00+02:00",
            groupId: CAPACITY_GROUP_ID,
          },
          {
            sessionId: "cap-s2",
            court: 2,
            slotTime: "15H00",
            slotEndTime: "15H45",
            userId: args.expectedPlayerIds[2],
            partnerId: args.expectedPlayerIds[3],
            startDate: "2026-07-20T15:00:00+02:00",
            groupId: CAPACITY_GROUP_ID,
          },
          {
            sessionId: "cap-s3",
            court: 3,
            slotTime: "17H00",
            slotEndTime: "17H45",
            userId: args.expectedPlayerIds[4],
            partnerId: args.expectedPlayerIds[5],
            startDate: "2026-07-20T17:00:00+02:00",
            groupId: CAPACITY_GROUP_ID,
          },
        ],
        warnings: [],
        meta,
        dryRun: true,
      };
    }

    return {
      proposedBookings: [
        {
          sessionId: `s-${args.startTime}`,
          court: args.startTime === "18H45" ? 2 : 3,
          slotTime: args.startTime,
          slotEndTime: args.startTime === "18H45" ? "19H30" : "20H15",
          userId: args.expectedPlayerIds[0],
          partnerId: args.expectedPlayerIds[1],
          startDate: `2026-07-20T${args.startTime === "18H45" ? "18:45" : "19:30"}:00+02:00`,
          groupId: "test-group-id",
        },
      ],
      warnings: [],
      meta: {
        courtsNeeded: 1,
        roundsPlanned: 1,
        dryRun: true,
        groupLabel: "test",
        recurringWeekday: 2,
        recurringStartTime: args.startTime,
        slotsPerPlayer: 1,
        groupMinSlotsPerPlayer: 2,
        groupMaxSlotsPerPlayer: 3,
        pairCount: 1,
      },
      dryRun: true,
    };
  },
  reserve_slot: async (args: { sessionId: string }) => ({ sessionId: args.sessionId, confirmed: true }),
  cancel_reservation: async () => ({}),
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
  name: null,
  enabled: true,
  whatsappGroupJid: "test@g.us",
  resaSquashGroupId: "test-group-id",
  pollCron: "0 10 * * 2",
  decisionCron: "30 21 * * 2",
  targetWeekdayOffset: 7,
  candidateStartTimes: ["18H45", "19H30"],
  maxCourtsPerSlot: 1,
  minPlayersPerCourt: 2,
  maxPlayersPerCourt: 2,
  maxReservationsPerPlayer: 2,
  priorityBookers: ["user-alice"],
  preferMinPlayersPerCourt: true,
  courtPriority: [2, 1],
  availabilityWindowHours: 3,
  description: null,
};

/** Scénario 3 (escalade capacité + fenêtre) — 6 confirmés, 1 seule heure candidate. */
const capacityRule: BookingRule = {
  ...bookingRule,
  id: "test-capacity-group",
  resaSquashGroupId: CAPACITY_GROUP_ID,
  candidateStartTimes: ["15H00"],
  maxCourtsPerSlot: 3,
  maxPlayersPerCourt: 3,
  maxReservationsPerPlayer: 1,
  courtPriority: [1, 2, 3],
  availabilityWindowHours: 1,
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

  console.log('--- 2ter. triggerRecollectVotes : Dave rejoint le groupe 19H30 (simulé) ---');
  // Valide seulement le mécanisme updateState(..., "waitForPlanTrigger") utilisé
  // par triggerRecollectVotes (scheduler.ts) — resolveVotes() lui-même est déjà
  // exercé par le passage CollectVotes ci-dessus, pas la peine de le remocker ici.
  // Avant recollect : 19H30 n'a que Carla (1 joueur < minPlayersPerCourt=2) —
  // après, Dave la rejoint, le groupe devient réservable.
  const beforeRecollect = await graph.getState(config);
  const before = (beforeRecollect.values.confirmedPlayerIdsByTime as Record<string, string[]>) ?? {};
  if ((before["19H30"]?.length ?? 0) !== 1) {
    throw new Error(`Échec : groupe 19H30 attendu à 1 joueur (Carla) avant recollect, reçu ${JSON.stringify(before["19H30"])}`);
  }
  const recollected = { ...before, "19H30": [...(before["19H30"] ?? []), "user-dave"] };
  await graph.updateState(config, { confirmedPlayerIdsByTime: recollected }, "waitForPlanTrigger");
  const afterRecollect = await graph.getState(config);
  if (afterRecollect.next?.[0] !== "bookSlots") {
    throw new Error(`Échec : updateState a déplacé le point de pause (next=${JSON.stringify(afterRecollect.next)}).`);
  }
  if (JSON.stringify(afterRecollect.values.confirmedPlayerIdsByTime) !== JSON.stringify(recollected)) {
    throw new Error(`Échec : confirmedPlayerIdsByTime pas mis à jour après updateState.`);
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
  console.log("✓ confirmedPlayerIdsByTime mis à jour (Dave rejoint 19H30) sans déplacer le point de pause");

  console.log("--- 2bis. BookSlots (cron du soir, action 2/2) — un appel plan_group_bookings par heure ---");
  const r2bis = await graph.invoke(new Command({ resume: true }), config);
  assertInterrupted(r2bis, "await-go");

  const planCalls = toolCalls.filter((c) => c.name === "plan_group_bookings");
  if (planCalls.length !== 2) {
    throw new Error(`Échec : 2 appels plan_group_bookings attendus (un par heure candidate), reçu ${planCalls.length}`);
  }
  const call1845 = planCalls.find((c) => (c.args as { startTime: string }).startTime === "18H45");
  const call1930 = planCalls.find((c) => (c.args as { startTime: string }).startTime === "19H30");
  if (!call1845 || !call1930) {
    throw new Error(`Échec : appels attendus pour 18H45 et 19H30, reçu ${JSON.stringify(planCalls.map((c) => (c.args as { startTime: string }).startTime))}`);
  }
  console.log("✓ un appel plan_group_bookings par heure candidate (18H45 et 19H30)");

  const orderedIds1845 = (call1845.args as { expectedPlayerIds: string[] }).expectedPlayerIds;
  if (orderedIds1845[0] !== "user-alice") {
    throw new Error(`Échec : priorityBookers non respecté sur 18H45, expectedPlayerIds = ${JSON.stringify(orderedIds1845)}`);
  }
  console.log('✓ priorityBookers respecté sur 18H45 (Alice en tête malgré la réponse de Bob en premier)');

  const orderedIds1930 = (call1930.args as { expectedPlayerIds: string[] }).expectedPlayerIds;
  if (!orderedIds1930.includes("user-carla") || !orderedIds1930.includes("user-dave")) {
    throw new Error(`Échec : groupe 19H30 attendu [Carla, Dave], reçu ${JSON.stringify(orderedIds1930)}`);
  }
  console.log("✓ groupe 19H30 contient bien Carla + Dave (recollect pris en compte par bookSlots)");

  const maxCourts1845 = (call1845.args as { maxCourts: number }).maxCourts;
  if (maxCourts1845 !== bookingRule.maxCourtsPerSlot) {
    throw new Error(`Échec : maxCourts=${maxCourts1845} attendu ${bookingRule.maxCourtsPerSlot}`);
  }
  console.log("✓ maxCourtsPerSlot/preferMinPlayersPerCourt/courtPriority transmis à plan_group_bookings");

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

  await testRealBooking(graph);
  await testCapacityEscalationAndWindow(graph);
  globalThis.fetch = originalFetch;
}

/**
 * Scénario 2 : case "dry-run" décochée dans l'UI (resume "go-real") — vérifie
 * que reserve_slot est réellement appelé (pas seulement plan_group_bookings
 * en dry-run) et que le message d'annonce le reflète. Thread séparé du
 * scénario 1 (dry-run) pour ne pas mélanger les deux.
 */
async function testRealBooking(graph: ReturnType<typeof buildPipelineGraph>): Promise<void> {
  console.log('\n=== Scénario 2 : réservation réelle (resume "go-real") ===');
  const jobId2 = "test-job-2";
  const config2 = { configurable: { thread_id: `${bookingRule.id}:${jobId2}` } };

  await graph.invoke({ bookingRule, targetDate: "2026-07-21" }, config2);
  await graph.invoke(new Command({ resume: true }), config2); // CollectVotes
  await graph.invoke(new Command({ resume: true }), config2); // BookSlots → await-go
  // Seul 18H45 a assez de joueurs confirmés (Bob+Alice) — Carla seule à 19H30
  // (< minPlayersPerCourt=2) ne produit aucune proposedBooking, donc aucun
  // reserve_slot pour ce groupe : 1 seul appel réel attendu, pas 2.

  const reserveCallsBefore = toolCalls.filter((c) => c.name === "reserve_slot").length;
  await graph.invoke(new Command({ resume: "go-real" }), config2);
  const reserveCallsAfter = toolCalls.filter((c) => c.name === "reserve_slot").length;
  if (reserveCallsAfter - reserveCallsBefore !== 1) {
    throw new Error(
      `Échec : 1 appel reserve_slot attendu (seul 18H45 a assez de joueurs), reçu ${reserveCallsAfter - reserveCallsBefore}`,
    );
  }
  console.log("✓ reserve_slot réellement appelé pour le groupe 18H45 (pas plan_group_bookings seul)");

  const lastBookingEvent = emittedEvents.filter((e) => e.type === "booking").at(-1);
  const detail = lastBookingEvent?.detail as { realBooking?: boolean; message?: string } | undefined;
  if (detail?.realBooking !== true) {
    throw new Error(`Échec : detail.realBooking attendu true, reçu ${JSON.stringify(detail)}`);
  }
  if (!detail.message?.includes("confirmée(s)")) {
    throw new Error(`Échec : message d'annonce attendu avec "confirmée(s)" pour une résa réelle, reçu "${detail.message}"`);
  }
  console.log('✓ message d\'annonce distinct pour une réservation réelle ("Réservation(s) confirmée(s)")');
}

/**
 * Scénario 3 (ADR-014) : 6 joueurs confirmés sur 1 heure candidate (15H00), courts
 * insuffisants en remplissage min → escalade automatique vers le remplissage max,
 * puis un des 3 créneaux obtenus tombe hors de la fenêtre de disponibilité
 * (availabilityWindowHours=1h) et ne doit ni être réservé, ni compté dans l'annonce.
 */
async function testCapacityEscalationAndWindow(graph: ReturnType<typeof buildPipelineGraph>): Promise<void> {
  console.log("\n=== Scénario 3 : escalade capacité min→max + fenêtre de disponibilité (ADR-014) ===");
  const jobId3 = "test-job-3";
  const config3 = { configurable: { thread_id: `${capacityRule.id}:${jobId3}` } };

  await graph.invoke({ bookingRule: capacityRule, targetDate: "2026-07-20" }, config3); // SendPoll → pause
  await graph.invoke(new Command({ resume: true }), config3); // CollectVotes → pause (waitForPlanTrigger)

  // Force 6 joueurs confirmés à 15H00 — les réponses du mock huddle-bot (Bob/Alice/Carla)
  // ne sont pas pertinentes ici, seul le nombre de joueurs confirmés compte pour ce scénario.
  const confirmed = { "15H00": ["p1", "p2", "p3", "p4", "p5", "p6"] };
  await graph.updateState(config3, { confirmedPlayerIdsByTime: confirmed }, "waitForPlanTrigger");

  capacityPlanCallCount = 0;
  const r3 = await graph.invoke(new Command({ resume: true }), config3); // BookSlots
  assertInterrupted(r3, "await-go");

  if (capacityPlanCallCount !== 2) {
    throw new Error(`Échec : escalade attendue (2 appels plan_group_bookings), reçu ${capacityPlanCallCount}`);
  }
  console.log("✓ escalade min→max déclenchée automatiquement (2 appels plan_group_bookings)");

  const stateAfterPlan = await graph.getState(config3);
  const groups =
    (stateAfterPlan.values as { bookingPlanGroups?: Array<{ startTime: string; outOfWindowSessionIds: string[] }> })
      .bookingPlanGroups ?? [];
  const capGroup = groups.find((g) => g.startTime === "15H00");
  if (!capGroup || JSON.stringify(capGroup.outOfWindowSessionIds) !== JSON.stringify(["cap-s3"])) {
    throw new Error(`Échec : outOfWindowSessionIds attendu ["cap-s3"], reçu ${JSON.stringify(capGroup?.outOfWindowSessionIds)}`);
  }
  console.log("✓ créneau hors fenêtre correctement identifié (cap-s3 à 17H00, > 15H00 + 1h)");

  const planSummaryMsg = telegramMessages.at(-1);
  if (!planSummaryMsg?.toLowerCase().includes("capacité")) {
    throw new Error(`Échec : message Telegram attendu avec avertissement de capacité, reçu : ${planSummaryMsg}`);
  }
  console.log("✓ avertissement de capacité envoyé sur Telegram avant même l'affichage du plan");

  const reserveCallsBefore = toolCalls.filter((c) => c.name === "reserve_slot").length;
  await graph.invoke(new Command({ resume: "go-real" }), config3);
  const reserveCallsAfter = toolCalls.filter((c) => c.name === "reserve_slot").length;
  if (reserveCallsAfter - reserveCallsBefore !== 2) {
    throw new Error(
      `Échec : 2 appels reserve_slot attendus (cap-s1, cap-s2 — cap-s3 hors fenêtre exclu), reçu ${reserveCallsAfter - reserveCallsBefore}`,
    );
  }
  console.log("✓ réservation réelle exclut le créneau hors fenêtre (2 reserve_slot, pas 3)");

  const lastBookingEvent = emittedEvents.filter((e) => e.type === "booking").at(-1);
  const detail = lastBookingEvent?.detail as { message?: string; unplacedPlayerCount?: number } | undefined;
  if (detail?.unplacedPlayerCount !== 2) {
    throw new Error(`Échec : unplacedPlayerCount attendu 2 (paire hors fenêtre), reçu ${JSON.stringify(detail)}`);
  }
  if (!detail.message?.includes("n'ont pas pu être réservé")) {
    throw new Error(`Échec : message d'annonce attendu avec l'avertissement joueurs non casés, reçu "${detail.message}"`);
  }
  console.log("✓ message d'annonce final mentionne les 2 joueurs non casés (capacité dépassée)");
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
