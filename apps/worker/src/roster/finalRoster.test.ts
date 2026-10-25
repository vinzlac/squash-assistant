import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { Identities, RosterFinal, RosterPlanSnapshot, VoteEventRow, VotePhoto } from "@squash-assistant/db/rosterTypes";
import type { GraphDependencies } from "../graph/dependencies.js";
import type { BookingPlanGroup, ReservationFailure } from "../graph/state.js";

vi.mock("../mcp/resaSquash.js", () => ({ lookupPlayerByPhone: vi.fn(async () => ({ found: false })) }));
vi.mock("../telegram/telegram.js", () => ({ sendTelegramMessage: vi.fn(async () => {}) }));
vi.mock("./rosterStore.js", () => ({
  listPollVoteEvents: vi.fn(async () => []),
  mergeRosterIdentities: vi.fn(async () => {}),
}));

const { buildRosterFinal, computeLiveRosters } = await import("./finalRoster.js");
const { __resetRefreshVotesTelegramLogForTests } = await import("./refreshVotes.js");
const { lookupPlayerByPhone } = await import("../mcp/resaSquash.js");
const { listPollVoteEvents } = await import("./rosterStore.js");
const { sendTelegramMessage } = await import("../telegram/telegram.js");

const deps = {
  db: {} as never,
  resaSquash: { client: {} as never, close: async () => {} },
  telegram: { botToken: "t", chatId: "c" },
} as unknown as Pick<GraphDependencies, "db" | "resaSquash" | "telegram">;

const GROUP = "group@g.us";
const TIMES = ["9H00", "10H30"];
const rule = { id: "rule-1", whatsappGroupJid: GROUP, candidateStartTimes: TIMES } as BookingRule;

const snapshot: RosterPlanSnapshot = {
  tPlan: "2026-10-25T18:00:00.000Z",
  state: {
    "tel:+331": { option: "9H00", lastAt: 1000 },
    "tel:+332": { option: "9H00", lastAt: 1100 },
    "tel:+333": { option: "10H30", lastAt: 1200 },
    "tel:+335": { option: null, lastAt: 1500 },
  },
  integratedEventIds: ["e0"],
};

const photo: VotePhoto = {
  capturedAt: "2026-10-24T10:00:00.000Z",
  integratedEventIds: ["e0"],
  voters: [
    { key: "tel:+331", phone: "+331", waName: "Henry", option: "9H00", votedAt: 1000 },
    { key: "tel:+332", phone: "+332", waName: "Stef", option: "9H00", votedAt: 1100 },
    { key: "tel:+333", phone: "+333", waName: "Lulu", option: "10H30", votedAt: 1200 },
    { key: "tel:+335", phone: "+335", waName: "Nono", option: "Non", votedAt: 1500 },
  ],
};
const identities: Identities = {
  "tel:+331": { userId: "u1", name: "Henry" },
  "tel:+332": { userId: "u2", name: "Stef" },
  "tel:+333": { userId: "u3", name: "Lulu" },
};

function booking(sessionId: string, slotTime: string) {
  return { sessionId, court: 4, userId: "u1", partnerId: "u2", slotTime, slotEndTime: "x", startDate: "d" };
}

function planGroup(startTime: string, bookings: ReturnType<typeof booking>[]): BookingPlanGroup {
  return { startTime, plan: { proposedBookings: bookings, warnings: [] } as never, outOfWindowSessionIds: [] };
}

function failure(sessionId: string): ReservationFailure {
  return { sessionId, court: 4, slotTime: "9H00", slotEndTime: "9H45", userId: "u1", partnerId: "u2", reason: null, message: "m", rawError: "r" };
}

const texts = { title: "🏸 Réservation", courtsBlock: "Court 4 : 9h00-9h45", failuresNote: "", capacityNote: "" };

describe("buildRosterFinal (spec roster vivant §4.5, R1-5)", () => {
  it("buildRosterFinal : heure avec créneau pris → capacity = nb de oui", () => {
    const final = buildRosterFinal({
      snapshot,
      groups: [planGroup("9H00", [booking("s1", "9H00")]), planGroup("10H30", [booking("s2", "10H30")])],
      failures: [],
      candidateStartTimes: TIMES,
      realBooking: true,
      ...texts,
    });
    expect(final).toEqual({
      base: snapshot,
      hours: [{ time: "9H00", capacity: 2 }, { time: "10H30", capacity: 1 }],
      realBooking: true,
      ...texts,
    });
  });

  it("buildRosterFinal : heure dont tous les créneaux sont refusés → capacity 0", () => {
    const final = buildRosterFinal({
      snapshot,
      groups: [planGroup("9H00", [booking("s1", "9H00"), booking("s3", "9H45")]), planGroup("10H30", [booking("s2", "10H30")])],
      failures: [failure("s1"), failure("s3")],
      candidateStartTimes: TIMES,
      realBooking: true,
      ...texts,
    });
    expect(final.hours).toEqual([{ time: "9H00", capacity: 0 }, { time: "10H30", capacity: 1 }]);
  });

  it("buildRosterFinal : heure dont le seul votant a été déplacé (groupe vide) → capacity 0", () => {
    const final = buildRosterFinal({
      snapshot,
      groups: [planGroup("9H00", [booking("s1", "9H00"), booking("s2", "9H00")]), planGroup("10H30", [])],
      failures: [],
      candidateStartTimes: TIMES,
      realBooking: false,
      ...texts,
    });
    expect(final.hours).toEqual([{ time: "9H00", capacity: 2 }, { time: "10H30", capacity: 0 }]);
  });

  it("une ligne hors fenêtre ne compte pas comme prise", () => {
    const final = buildRosterFinal({
      snapshot,
      groups: [{ ...planGroup("9H00", [booking("s1", "9H00")]), outOfWindowSessionIds: ["s1"] }, planGroup("10H30", [booking("s2", "10H30")])],
      failures: [],
      candidateStartTimes: TIMES,
      realBooking: false,
      ...texts,
    });
    expect(final.hours[0]).toEqual({ time: "9H00", capacity: 0 });
  });
});

function event(overrides: Partial<VoteEventRow>): VoteEventRow {
  return {
    eventId: "e1",
    eventType: "poll_vote_creation",
    createdAt: new Date(3000),
    occurredAt: new Date(3000),
    actorPhone: "+334",
    actorJid: "334@s.whatsapp.net",
    actorName: "Max",
    selectedOptions: ["9H00"],
    previousOptions: [],
    ...overrides,
  };
}

function job(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: "job-1",
    targetDate: "2026-11-01",
    pollMsgId: "poll-msg",
    candidateStartTimes: TIMES,
    rosterPhoto: photo,
    rosterIdentities: identities,
    rosterPlanSnapshot: snapshot,
    rosterFinal: null,
    ...overrides,
  } as JobRun;
}

const final: RosterFinal = {
  base: snapshot,
  hours: [{ time: "9H00", capacity: 2 }, { time: "10H30", capacity: 1 }],
  realBooking: true,
  ...texts,
};

describe("computeLiveRosters (spec roster vivant §4.5, P2-4)", () => {
  beforeEach(() => {
    vi.mocked(listPollVoteEvents).mockReset().mockResolvedValue([]);
    vi.mocked(lookupPlayerByPhone).mockReset().mockResolvedValue({ found: false });
    vi.mocked(sendTelegramMessage).mockClear();
    __resetRefreshVotesTelegramLogForTests();
  });

  it("job legacy (roster_photo nul) : null", async () => {
    expect(await computeLiveRosters(deps, job({ rosterPhoto: null }), rule, "Samedi")).toBeNull();
  });

  it("computeLiveRosters : un vote après le plan est appliqué (attente), jamais réécrit au tick suivant", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([event({ eventId: "e0" }), event({ eventId: "e1" })]);

    const first = await computeLiveRosters(deps, job(), rule, "Samedi", { final });
    const second = await computeLiveRosters(deps, job(), rule, "Samedi", { final });

    expect(listPollVoteEvents).toHaveBeenCalledWith(deps.db, { chatJid: GROUP, pollMsgId: "poll-msg" });
    expect(first!.phase).toBe("final");
    expect(first!.text).toContain("⏰ 9h (2/2) : Henry, Stef");
    expect(first!.text).toContain("⏳ En attente 9h : Max");
    expect(first!.text).toContain("Pour te désister");
    expect(first!.rosters.find((r) => r.time === "9H00")!.waiting).toEqual(["tel:+334"]);
    expect(second!.text).toBe(first!.text);
  });

  // R2-16 / BR1-6 : un retrait sans option (avant ni après) est un désistement, la place passe au premier en attente.
  const maxWaiting = event({ eventId: "e1" });
  const henryEmptyRetraction = event({
    eventId: "e2",
    occurredAt: new Date(4000),
    actorPhone: "+331",
    actorName: "Henry",
    actorJid: "331@s.whatsapp.net",
    selectedOptions: [],
    previousOptions: [],
  });

  it("retrait vide d'un inscrit : le premier en attente prend sa place, Telegram avec l'ancienne option", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([maxWaiting, henryEmptyRetraction]);

    const result = await computeLiveRosters(deps, job(), rule, "Samedi", { final });

    expect(result!.text).toContain("Max (remplace Henry)");
    expect(result!.text).not.toContain("En attente 9h");
    const telegrams = vi.mocked(sendTelegramMessage).mock.calls.map(([, text]) => text);
    // Max (+334) est un votant tardif inconnu de resa-squash : son Telegram B1-4 s'ajoute, indépendamment du retrait.
    const retractions = telegrams.filter((t) => t.includes("désistement"));
    expect(retractions).toHaveLength(1);
    expect(retractions[0]).toContain("avait 9H00");
    expect(retractions[0]).toContain("Henry (331@s.whatsapp.net)");
    expect(telegrams.filter((t) => !t.includes("désistement")).join("\n")).toContain("Max");
  });

  it("retrait vide puis revote de la même heure à la même seconde : Henry repasse en fin d'attente", async () => {
    const henryRevote = event({
      eventId: "e3",
      occurredAt: new Date(4000),
      actorPhone: "+331",
      actorName: "Henry",
      actorJid: "331@s.whatsapp.net",
      selectedOptions: ["9H00"],
      previousOptions: [],
    });
    vi.mocked(listPollVoteEvents).mockResolvedValue([maxWaiting, henryEmptyRetraction, henryRevote]);

    const result = await computeLiveRosters(deps, job(), rule, "Samedi", { final });

    expect(result!.text).toContain("Max (remplace Henry)");
    expect(result!.text).toContain("⏳ En attente 9h : Henry");
  });

  it("utilise job.rosterFinal sans option", async () => {
    const result = await computeLiveRosters(deps, job({ rosterFinal: final }), rule, "Samedi");
    expect(result!.phase).toBe("final");
    expect(result!.text.startsWith("🏸 Réservation")).toBe(true);
  });

  it("sans rosterFinal : texte provisoire (photo + événements), un « Non » passé à « oui » affiché par son nom", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([
      event({ eventId: "e1", actorPhone: "+335", actorName: "Nono", selectedOptions: ["10H30"], previousOptions: ["Non"] }),
    ]);

    const result = await computeLiveRosters(deps, job({ rosterPlanSnapshot: null }), rule, "Samedi");

    expect(result!.phase).toBe("provisional");
    expect(result!.rosters).toEqual([]);
    expect(result!.text).toContain("Lulu, Nono");
    expect(result!.text).toContain("Les courts arrivent bientôt 😉");
  });
});
