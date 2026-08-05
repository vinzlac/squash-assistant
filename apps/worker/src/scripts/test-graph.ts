import { Command, MemorySaver } from "@langchain/langgraph";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { JobRun } from "@squash-assistant/db/schema";
import { buildPipelineGraph } from "../graph/buildGraph.js";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "../graph/nodes/pollQuestion.js";
import { getJobExecutionStatus } from "../scheduler/scheduler.js";
import type { BookingRule } from "../config.js";
import type { Database } from "@squash-assistant/db/client";
import type { AvailabilitySlot } from "../mcp/resaSquash.js";
import type { BookingPlanGroup } from "../graph/state.js";

/**
 * Validation Phase 2 (docs/plan/squash-assistant-poc.md §7) : pipeline complet
 * SendPoll → CollectVotes → BookSlots → Announce sur des mocks MCP/Telegram,
 * sans dépendre d'un vrai groupe WhatsApp ni des vraies API. Exercice aussi
 * les deux pauses interrupt() (fenêtre de décision, confirmation "go") et
 * l'ordre de priorité des réservataires (priorityBookers).
 *
 * Depuis le rapatriement du moteur de plan côté squash-assistant (ADR-018),
 * bookSlots.ts n'appelle plus resa-squash pour calculer le plan
 * (plan_group_bookings a disparu) : il lit les disponibilités brutes
 * (list_availability) et les réservations existantes du titulaire de la clé
 * API (list_my_reservations_on_date), puis calcule lui-même les réservations
 * proposées via computeGroupBookingPlan (déjà unitairement testé côté
 * groupBookingPlan.test.ts). Ce script mocke donc ces deux tools MCP avec des
 * disponibilités fabriquées, et laisse le VRAI moteur calculer le plan —
 * contrairement à l'ancienne version qui injectait des proposedBookings
 * "en dur" via un mock de plan_group_bookings.
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
    // Erwan répond "prête-nom volontaire" (ADR-017) — ne doit jamais apparaître
    // dans confirmedPlayerIdsByTime, seulement dans volunteerSubstituteIds.
    responses: [
      { member: "Bob", phone: "33687654321", statut: "18H45" },
      { member: "Alice", phone: "33612345678", statut: "18H45" },
      { member: "Carla", phone: "33611112222", statut: "19H30" },
      { member: "Erwan", phone: "33611114444", statut: SUBSTITUTE_VOLUNTEER_POLL_OPTION },
    ],
  },
  send_message: {},
});

const PHONE_TO_USER_ID: Record<string, string> = {
  "+33612345678": "user-alice",
  "+33687654321": "user-bob",
  "+33611112222": "user-carla",
  "+33611113333": "user-dave",
  "+33611114444": "user-erwan",
};

/** groupId dédié au scénario 3 (escalade capacité + fenêtre) — sert de resaSquashGroupId (metadata des proposedBookings), l'isolation entre scénarios se fait par thread_id (jobId), pas par ce groupId. */
const CAPACITY_GROUP_ID = "test-capacity-group-id";

function makeAvailabilitySlots(
  courts: number[],
  date: string,
  time: string,
  endTime: string,
): AvailabilitySlot[] {
  return courts.map((court) => ({
    id: `s-${date}-${court}-${time}`,
    court,
    time,
    endTime,
    date,
    participants: 0,
    available: true,
    users: [],
  }));
}

/**
 * Disponibilités brutes (list_availability) par date, fabriquées pour que le VRAI moteur
 * (computeGroupBookingPlan) produise les résultats attendus par chaque scénario :
 *
 * - "2026-07-20" (scénarios 1 et 3, threads distincts, courts/heures disjoints donc aucune
 *   interférence) :
 *   - courts 1 et 2 à 18H45/19H30/20H15 → scénario 1 (2 groupes de 2 joueurs, 2 créneaux/joueur,
 *     maxCourtsPerSlot=1) : le groupe 18H45 doit obtenir 2 rounds consécutifs sur UN court par
 *     continuité (18H45-19H30 puis 19H30-20H15) ; le groupe 19H30, traité ensuite avec
 *     usedSessionIds partagé, ne peut plus utiliser le court déjà pris à 19H30-20H15 par le
 *     groupe 18H45 et doit donc basculer sur l'autre court pour ses 2 rounds
 *     (19H30-20H15 puis 20H15-21H00).
 *   - courts 1 et 2 à 15H00 (2 courts) + court 3 seul à 17H00 → scénario 3 : jamais 3 courts
 *     simultanément disponibles, donc le remplissage min (courtsNeededForPlayers(6, true) = 3)
 *     échoue totalement en 1ère tentative ; l'escalade vers le remplissage max
 *     (courtsNeededForPlayers(6, false) = 2) réussit en casant 2 paires à 15H00 (courts 1 et 2)
 *     et la 3e à 17H00 (court 3) — hors de la fenêtre d'1h (availabilityWindowHours=1).
 * - "2026-07-21" (scénario 2, thread séparé) : uniquement courts 1 et 2 à 18H45 — un seul round
 *   possible (pas de créneau suivant disponible), ce qui produit exactement 1 proposedBooking
 *   pour le groupe 18H45 malgré maxReservationsPerPlayer=2.
 */
const availabilityByDate: Record<string, AvailabilitySlot[]> = {
  "2026-07-20": [
    ...makeAvailabilitySlots([1, 2], "2026-07-20", "18H45", "19H30"),
    ...makeAvailabilitySlots([1, 2], "2026-07-20", "19H30", "20H15"),
    ...makeAvailabilitySlots([1, 2], "2026-07-20", "20H15", "21H00"),
    ...makeAvailabilitySlots([1, 2], "2026-07-20", "15H00", "15H45"),
    ...makeAvailabilitySlots([3], "2026-07-20", "17H00", "17H45"),
  ],
  "2026-07-21": [...makeAvailabilitySlots([1, 2], "2026-07-21", "18H45", "19H30")],
};

const resaSquashClient = mockClient({
  lookup_player_by_phone: async (args: { phone: string }) => ({
    found: true,
    userId: PHONE_TO_USER_ID[args.phone],
  }),
  // Disponibilités brutes — le VRAI computeGroupBookingPlan (bookSlots.ts) calcule le plan
  // à partir de ces slots, il n'est plus injecté "en dur" ici (voir availabilityByDate ci-dessus).
  list_availability: async (args: { dateFrom: string; dateTo: string }) => ({
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    availability: [{ date: args.dateFrom, slots: availabilityByDate[args.dateFrom] ?? [] }],
  }),
  // Titulaire de la clé API : aucune résa existante ce jour-là, jamais à quota dans ces scénarios
  // (le remplacement titulaire→prête-nom est déjà testé isolément côté groupBookingPlan.test.ts).
  list_my_reservations_on_date: async (args: { onDate: string }) => ({
    userId: "api-key-holder",
    onDate: args.onDate,
    timeZone: "Europe/Paris",
    reservations: [],
  }),
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
  substituteBookers: [],
  maxDailyReservationsPerPlayer: 2,
  unexpectedPlayersMargin: 0,
    reservationNotifyWhatsappGroupJid: null,
    cronJitterWindowMinutes: 60,
  requireTelegramGoForAutoJobs: true,
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

  console.log("--- 2bis. volunteerSubstituteIds (prête-nom volontaire, ADR-017) ---");
  const afterCollect = await graph.getState(config);
  const volunteers = (afterCollect.values.volunteerSubstituteIds as string[]) ?? [];
  if (JSON.stringify(volunteers) !== JSON.stringify(["user-erwan"])) {
    throw new Error(`Échec : volunteerSubstituteIds attendu ["user-erwan"], reçu ${JSON.stringify(volunteers)}`);
  }
  const confirmedAfterCollect = (afterCollect.values.confirmedPlayerIdsByTime as Record<string, string[]>) ?? {};
  if (Object.values(confirmedAfterCollect).flat().includes("user-erwan")) {
    throw new Error("Échec : Erwan (prête-nom volontaire) ne doit jamais apparaître dans confirmedPlayerIdsByTime.");
  }

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

  console.log("--- 2bis. BookSlots (cron du soir, action 2/2) — moteur local (list_availability + list_my_reservations_on_date) ---");
  const r2bis = await graph.invoke(new Command({ resume: true }), config);
  assertInterrupted(r2bis, "await-go");

  const stateAfterBook = await graph.getState(config);
  const groupsAfterBook = (stateAfterBook.values.bookingPlanGroups as BookingPlanGroup[] | undefined) ?? [];
  if (groupsAfterBook.length !== 2) {
    throw new Error(`Échec : 2 groupes de plan attendus (un par heure candidate), reçu ${groupsAfterBook.length}`);
  }
  const group1845 = groupsAfterBook.find((g) => g.startTime === "18H45");
  const group1930 = groupsAfterBook.find((g) => g.startTime === "19H30");
  if (!group1845 || !group1930) {
    throw new Error(
      `Échec : groupes attendus pour 18H45 et 19H30, reçu ${JSON.stringify(groupsAfterBook.map((g) => g.startTime))}`,
    );
  }
  console.log("✓ un groupe de plan par heure candidate (18H45 et 19H30), calculé localement par computeGroupBookingPlan");

  const players1845 = new Set(
    group1845.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId].filter((v): v is string => Boolean(v))),
  );
  if (!players1845.has("user-alice") || !players1845.has("user-bob")) {
    throw new Error(`Échec : groupe 18H45 attendu [Alice, Bob], reçu ${JSON.stringify([...players1845])}`);
  }
  console.log("✓ groupe 18H45 contient bien Alice + Bob");

  if (group1845.plan.proposedBookings.every((b) => b.userId !== "user-alice")) {
    throw new Error("Échec : priorityBookers non respecté — Alice devrait être en tête de paire (userId) sur 18H45.");
  }
  console.log('✓ priorityBookers respecté sur 18H45 (Alice en tête de paire malgré la réponse de Bob en premier)');

  const players1930 = new Set(
    group1930.plan.proposedBookings.flatMap((b) => [b.userId, b.partnerId].filter((v): v is string => Boolean(v))),
  );
  if (!players1930.has("user-carla") || !players1930.has("user-dave")) {
    throw new Error(`Échec : groupe 19H30 attendu [Carla, Dave], reçu ${JSON.stringify([...players1930])}`);
  }
  console.log("✓ groupe 19H30 contient bien Carla + Dave (recollect pris en compte par bookSlots)");

  if (group1845.plan.proposedBookings.length !== 2 || group1930.plan.proposedBookings.length !== 2) {
    throw new Error(
      `Échec : 2 réservations attendues par groupe (maxReservationsPerPlayer=2), reçu 18H45=${group1845.plan.proposedBookings.length} 19H30=${group1930.plan.proposedBookings.length}`,
    );
  }
  console.log("✓ 2 réservations par groupe (continuité de court sur les 2 rounds — maxReservationsPerPlayer=2)");

  const courts1845 = new Set(group1845.plan.proposedBookings.map((b) => b.court));
  const courts1930 = new Set(group1930.plan.proposedBookings.map((b) => b.court));
  if (courts1845.size !== 1 || courts1930.size !== 1) {
    throw new Error(
      `Échec : maxCourtsPerSlot=1 attendu — un seul court par heure candidate, reçu 18H45=${JSON.stringify([...courts1845])} 19H30=${JSON.stringify([...courts1930])}`,
    );
  }
  const court1845 = [...courts1845][0]!;
  const court1930 = [...courts1930][0]!;
  if (!bookingRule.courtPriority.includes(court1845) || !bookingRule.courtPriority.includes(court1930)) {
    throw new Error(`Échec : courts attendus parmi courtPriority=${JSON.stringify(bookingRule.courtPriority)}, reçu ${court1845}/${court1930}`);
  }
  if (court1845 === court1930) {
    throw new Error(
      `Échec : le groupe 19H30 aurait dû basculer sur un autre court que le 18H45 (usedSessionIds partagé), reçu le même court ${court1845} pour les deux.`,
    );
  }
  console.log(
    `✓ courtPriority/maxCourtsPerSlot respectés (un seul court par groupe, parmi [${bookingRule.courtPriority.join(",")}]) ; le groupe 19H30 (court ${court1930}) a bien basculé sur un court différent du 18H45 (court ${court1845}) à cause du partage de usedSessionIds`,
  );

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
 * que reserve_slot est réellement appelé (pas seulement le plan calculé en
 * dry-run) et que le message d'annonce le reflète. Thread séparé du scénario 1
 * (dry-run), et date séparée (2026-07-21) avec sa propre fixture de
 * disponibilité (courts 1/2 à 18H45 uniquement — voir availabilityByDate) :
 * un seul round est possible faute de créneau suivant, ce qui produit
 * exactement 1 proposedBooking pour le groupe 18H45 malgré
 * maxReservationsPerPlayer=2, donc exactement 1 appel reserve_slot.
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
  // reserve_slot pour ce groupe. Et le groupe 18H45 lui-même ne produit qu'1
  // proposedBooking (pas 2) faute de créneau suivant disponible dans la
  // fixture de ce jour-là (voir availabilityByDate["2026-07-21"]).

  const reserveCallsBefore = toolCalls.filter((c) => c.name === "reserve_slot").length;
  await graph.invoke(new Command({ resume: "go-real" }), config2);
  const reserveCallsAfter = toolCalls.filter((c) => c.name === "reserve_slot").length;
  if (reserveCallsAfter - reserveCallsBefore !== 1) {
    throw new Error(
      `Échec : 1 appel reserve_slot attendu (seul 18H45 a assez de joueurs, et 1 seul round faute de créneau suivant), reçu ${reserveCallsAfter - reserveCallsBefore}`,
    );
  }
  console.log("✓ reserve_slot réellement appelé pour le groupe 18H45 (plan calculé localement, pas seulement en dry-run)");

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
 *
 * Reconstruit via une vraie pénurie de créneaux (voir availabilityByDate["2026-07-20"] :
 * courts 1+2 à 15H00, court 3 seul à 17H00, jamais 3 courts simultanément) plutôt qu'un
 * plan_group_bookings mocké :
 * - remplissage min (courtsNeededForPlayers(6, true) = 3 courts requis) : aucun horaire
 *   n'offre 3 courts simultanés → 0 paire casée, escalade déclenchée (shortfall != 0).
 * - remplissage max (courtsNeededForPlayers(6, false) = 2 courts requis) : 2 paires casées
 *   à 15H00 (courts 1 et 2), la 3e à 17H00 (court 3, seul disponible à ce moment) — hors de
 *   la fenêtre d'1h après 15H00.
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

  const r3 = await graph.invoke(new Command({ resume: true }), config3); // BookSlots
  assertInterrupted(r3, "await-go");

  const stateAfterPlan = await graph.getState(config3);
  const groups = (stateAfterPlan.values.bookingPlanGroups as BookingPlanGroup[] | undefined) ?? [];
  const capGroup = groups.find((g) => g.startTime === "15H00");
  if (!capGroup) {
    throw new Error(`Échec : groupe 15H00 attendu, reçu ${JSON.stringify(groups.map((g) => g.startTime))}`);
  }

  if (capGroup.plan.proposedBookings.length !== 3) {
    throw new Error(
      `Échec : 3 réservations attendues après escalade (min-fill échoue totalement, max-fill case les 3 paires), reçu ${capGroup.plan.proposedBookings.length}`,
    );
  }
  if (capGroup.plan.meta.courtsNeeded !== 2) {
    throw new Error(
      `Échec : courtsNeeded=2 attendu après escalade vers le remplissage max (courtsNeededForPlayers(6, false)), reçu ${capGroup.plan.meta.courtsNeeded}`,
    );
  }
  console.log("✓ escalade min→max déclenchée automatiquement (0/3 paire casée en remplissage min faute de 3 courts simultanés, 3/3 en remplissage max)");

  const court3Booking = capGroup.plan.proposedBookings.find((b) => b.court === 3);
  if (!court3Booking) {
    throw new Error("Échec : aucune réservation sur le court 3 (celle attendue hors fenêtre, à 17H00).");
  }
  if (JSON.stringify(capGroup.outOfWindowSessionIds) !== JSON.stringify([court3Booking.sessionId])) {
    throw new Error(
      `Échec : outOfWindowSessionIds attendu [${court3Booking.sessionId}], reçu ${JSON.stringify(capGroup.outOfWindowSessionIds)}`,
    );
  }
  console.log("✓ créneau hors fenêtre correctement identifié (court 3 à 17H00, > 15H00 + 1h)");

  const planSummaryMsg = telegramMessages.at(-1);
  // Libellé neutre depuis 2026-07-25 (ne prétend plus "capacité des courts" —
  // la cause peut être un garde-fou resa-squash, pas un vrai manque de courts).
  if (!planSummaryMsg?.includes("risquent de ne pas avoir de créneau")) {
    throw new Error(`Échec : message Telegram attendu avec avertissement de shortfall, reçu : ${planSummaryMsg}`);
  }
  console.log("✓ avertissement de shortfall envoyé sur Telegram avant même l'affichage du plan");

  const reserveCallsBefore = toolCalls.filter((c) => c.name === "reserve_slot").length;
  await graph.invoke(new Command({ resume: "go-real" }), config3);
  const reserveCallsAfter = toolCalls.filter((c) => c.name === "reserve_slot").length;
  if (reserveCallsAfter - reserveCallsBefore !== 2) {
    throw new Error(
      `Échec : 2 appels reserve_slot attendus (les 2 paires à 15H00 — la paire à 17H00 hors fenêtre exclue), reçu ${reserveCallsAfter - reserveCallsBefore}`,
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
  console.log("✓ message d'annonce final mentionne les 2 joueurs non casés");
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
