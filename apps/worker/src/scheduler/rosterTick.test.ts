import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { Identities, RosterFinal, VoteEventRow, VotePhoto } from "@squash-assistant/db/rosterTypes";
import type { PipelineGraph } from "../graph/buildGraph.js";

vi.mock("../roster/rosterStore.js", () => ({
  listPollVoteEvents: vi.fn(),
  mergeRosterIdentities: vi.fn(),
  claimRosterPublish: vi.fn(),
  releaseRosterPublish: vi.fn(),
  setRosterMessage: vi.fn(),
  setRosterFingerprint: vi.fn(),
  setRosterPinnedAt: vi.fn(),
  setRosterOrphan: vi.fn(),
  setRosterStoppedAt: vi.fn(),
  setPollUnpinnedAt: vi.fn(),
  saveRosterFinal: vi.fn(),
  listJobsWithRoster: vi.fn(),
  listJobsWithRosterOrphan: vi.fn(),
  listJobsWithPinnedPoll: vi.fn(),
}));
vi.mock("../mcp/huddleBot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp/huddleBot.js")>()),
  sendMessage: vi.fn(),
  deleteMessage: vi.fn(),
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
}));
vi.mock("../mcp/resaSquash.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp/resaSquash.js")>()),
  lookupPlayerByPhone: vi.fn(),
}));
vi.mock("../telegram/telegram.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telegram/telegram.js")>()),
  sendTelegramMessage: vi.fn(),
}));
vi.mock("../jobRuns.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jobRuns.js")>()),
  findActiveJobRunForDate: vi.fn(),
}));
vi.mock("../bookingRules.js", () => ({ loadBookingRules: vi.fn(), getBookingRuleById: vi.fn() }));

import {
  claimRosterPublish,
  listJobsWithPinnedPoll,
  listJobsWithRoster,
  listJobsWithRosterOrphan,
  listPollVoteEvents,
  mergeRosterIdentities,
  releaseRosterPublish,
  setPollUnpinnedAt,
  setRosterFingerprint,
  setRosterMessage,
  setRosterOrphan,
  setRosterPinnedAt,
  setRosterStoppedAt,
} from "../roster/rosterStore.js";
import { deleteMessage, pinMessage, sendMessage, unpinMessage } from "../mcp/huddleBot.js";
import { lookupPlayerByPhone } from "../mcp/resaSquash.js";
import { sendTelegramMessage } from "../telegram/telegram.js";
import { findActiveJobRunForDate } from "../jobRuns.js";
import { getBookingRuleById, loadBookingRules } from "../bookingRules.js";
import { __resetRosterTelegramLogForTests } from "../roster/publishRoster.js";
import { __resetRefreshVotesTelegramLogForTests } from "../roster/refreshVotes.js";
import { __resetRosterTickLogForTests, triggerRosterRefresh } from "./rosterTick.js";

const GROUP = "g@test";
const TARGET = "2026-10-10";
// samedi 10 octobre 2026, Paris = UTC+2
const atParis = (minutes: number, dayOffset = 0) =>
  new Date(Date.UTC(2026, 9, 9 + dayOffset, 22, 0) + minutes * 60_000);
const BEFORE_SLOT = atParis(9 * 60);
const SLOT = atParis(10 * 60 + 30);

const huddleBot = { client: {} as never, close: async () => {} };
const resaSquash = { client: {} as never, close: async () => {} };
const telegram = { botToken: "t", chatId: "c" };
const db = {} as never;

function rule(overrides: Partial<BookingRule> = {}): BookingRule {
  return {
    id: "rule-1",
    name: "Samedi",
    whatsappGroupJid: GROUP,
    candidateStartTimes: ["10H30"],
    reservationNotifyWhatsappGroupJid: null,
    pinMessagesEnabled: true,
    ...overrides,
  } as BookingRule;
}

const photo: VotePhoto = {
  capturedAt: "2026-10-03T10:00:00.000Z",
  integratedEventIds: [],
  voters: [{ key: "tel:+331", phone: "+331", waName: "Henry", option: "10H30", votedAt: 1000 }],
};
const identities: Identities = { "tel:+331": { userId: "u1", name: "Henry" } };

const rosterFinal: RosterFinal = {
  base: { tPlan: "2026-10-03T18:00:00.000Z", state: { "tel:+331": { option: "10H30", lastAt: 1000 } }, integratedEventIds: [] },
  hours: [{ time: "10H30", capacity: 1 }],
  realBooking: false,
  title: "🎾 Courts réservés",
  courtsBlock: "Court 4 : 10h30",
  failuresNote: "",
  capacityNote: "",
};

function job(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: "job-1",
    bookingRuleId: "rule-1",
    targetDate: TARGET,
    pollMsgId: "poll-1",
    cancelledAt: null,
    candidateStartTimes: ["10H30"],
    ruleSnapshot: rule(),
    rosterPhoto: photo,
    rosterIdentities: identities,
    rosterFinal: null,
    rosterMsgId: null,
    rosterJid: null,
    rosterSentAt: null,
    rosterFingerprint: null,
    rosterPinnedAt: null,
    rosterOrphan: null,
    rosterClaimedAt: null,
    rosterStoppedAt: null,
    pollUnpinnedAt: null,
    ...overrides,
  } as JobRun;
}

/** Roster courant publié il y a une heure, épinglé. */
function withRoster(overrides: Partial<JobRun> = {}): JobRun {
  return job({
    rosterMsgId: "r1",
    rosterJid: GROUP,
    rosterSentAt: new Date(BEFORE_SLOT.getTime() - 3600_000),
    rosterFingerprint: "old-fp",
    rosterPinnedAt: new Date(BEFORE_SLOT.getTime() - 3600_000),
    ...overrides,
  });
}

function voteEvent(id: string, phone: string, name: string, option: string): VoteEventRow {
  return {
    eventId: id,
    eventType: "poll_vote_creation",
    createdAt: new Date("2026-10-04T10:00:00Z"),
    occurredAt: new Date("2026-10-04T10:00:00Z"),
    actorPhone: phone,
    actorJid: `${phone}@s.whatsapp.net`,
    actorName: name,
    selectedOptions: [option],
    previousOptions: [],
  };
}

const slotGroup = (slotTime = "10H30") => ({
  startTime: slotTime,
  outOfWindowSessionIds: [],
  plan: {
    proposedBookings: [{ sessionId: "s1", court: 4, userId: "u1", partnerId: "u2", slotTime, slotEndTime: "11H15" }],
    warnings: [],
    meta: {},
  },
});

const STAGES = {
  awaitingGo: { next: ["waitForGoConfirmation"], values: { pollRequestId: "p" } },
  announced: { next: [], values: { pollRequestId: "p", goConfirmed: true, bookingPlanGroups: [slotGroup()] } },
  noPlan: { next: [], values: { pollRequestId: "p", bookingPlanGroups: [] } },
  cancelled: { next: [], values: { pollRequestId: "p", goConfirmed: false, bookingPlanGroups: [slotGroup()] } },
  error: { next: ["announce"], values: { pollRequestId: "p", goConfirmed: true, bookingPlanGroups: [slotGroup()] } },
} as const;

// Base en mémoire : les écritures du store mettent à jour la ligne, les listes la relisent.
let rows: Record<string, JobRun> = {};
let graphState: { next: readonly string[]; values: Record<string, unknown> } = STAGES.awaitingGo;
let events: VoteEventRow[] = [];
let liveRule = rule();
const graph = { getState: vi.fn(async () => graphState) } as unknown as PipelineGraph;

const row = (id = "job-1") => rows[id]!;
function patch(id: string, values: Partial<JobRun>): void {
  rows = { ...rows, [id]: { ...rows[id]!, ...values } };
}
function seed(...jobs: JobRun[]): void {
  rows = Object.fromEntries(jobs.map((j) => [j.id, j]));
}

const tick = (now: Date) => triggerRosterRefresh(now, graph, telegram, db, huddleBot, resaSquash);
const sentTexts = () => vi.mocked(sendMessage).mock.calls.map(([, , text]) => text);

beforeEach(() => {
  vi.resetAllMocks();
  __resetRosterTelegramLogForTests();
  __resetRefreshVotesTelegramLogForTests();
  __resetRosterTickLogForTests();
  rows = {};
  graphState = STAGES.awaitingGo;
  events = [];
  liveRule = rule();
  vi.mocked(graph.getState).mockImplementation(async () => graphState as never);

  vi.mocked(loadBookingRules).mockImplementation(async () => [liveRule]);
  vi.mocked(getBookingRuleById).mockImplementation(async () => liveRule);
  vi.mocked(findActiveJobRunForDate).mockImplementation(async (_db, ruleId, date) =>
    Object.values(rows).find((r) => r.bookingRuleId === ruleId && r.targetDate === date && !r.cancelledAt),
  );
  vi.mocked(listPollVoteEvents).mockImplementation(async () => events);
  vi.mocked(listJobsWithRoster).mockImplementation(async (_db, fromDate) =>
    Object.values(rows).filter((r) => r.rosterPhoto && !r.rosterStoppedAt && !r.cancelledAt && r.targetDate >= fromDate),
  );
  vi.mocked(listJobsWithRosterOrphan).mockImplementation(async () => Object.values(rows).filter((r) => r.rosterOrphan));
  vi.mocked(listJobsWithPinnedPoll).mockImplementation(async () =>
    Object.values(rows).filter((r) => r.rosterPhoto && r.pollMsgId && !r.pollUnpinnedAt),
  );
  vi.mocked(claimRosterPublish).mockImplementation(async (_db, id) => ({ job: row(id), reclaimedStale: false }));
  vi.mocked(releaseRosterPublish).mockResolvedValue(undefined);
  vi.mocked(setRosterMessage).mockImplementation(async (_db, id, msg) =>
    patch(id, {
      rosterMsgId: msg?.msgId ?? null,
      rosterJid: msg?.jid ?? null,
      rosterSentAt: msg?.sentAt ?? null,
      rosterFingerprint: msg?.fingerprint ?? null,
      rosterPinnedAt: null,
    }),
  );
  vi.mocked(setRosterFingerprint).mockImplementation(async (_db, id, fp) => patch(id, { rosterFingerprint: fp }));
  vi.mocked(setRosterPinnedAt).mockImplementation(async (_db, id, at) => patch(id, { rosterPinnedAt: at }));
  vi.mocked(setRosterOrphan).mockImplementation(async (_db, id, orphan) => patch(id, { rosterOrphan: orphan }));
  vi.mocked(setRosterStoppedAt).mockImplementation(async (_db, id, at) => patch(id, { rosterStoppedAt: at }));
  vi.mocked(setPollUnpinnedAt).mockImplementation(async (_db, id, at) => patch(id, { pollUnpinnedAt: at }));
  vi.mocked(mergeRosterIdentities).mockImplementation(async (_db, id, p, mode) => {
    const current = row(id).rosterIdentities ?? {};
    patch(id, { rosterIdentities: mode === "keep" ? { ...p, ...current } : { ...current, ...p } });
  });

  vi.mocked(sendMessage).mockResolvedValue({ msgId: "new-msg" });
  vi.mocked(deleteMessage).mockResolvedValue(undefined as never);
  vi.mocked(pinMessage).mockResolvedValue({ expiresAt: 0 } as never);
  vi.mocked(unpinMessage).mockResolvedValue(undefined);
  vi.mocked(sendTelegramMessage).mockResolvedValue(undefined);
  vi.mocked(lookupPlayerByPhone).mockResolvedValue({ found: false } as never);
});

describe("triggerRosterRefresh — publication (CA-9)", () => {
  it("CA-9 : un vote change → nouveau roster publié via publishRoster", async () => {
    seed(withRoster());
    events = [voteEvent("e1", "+332", "Stef", "10H30")];

    await tick(BEFORE_SLOT);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMessage).mock.calls[0]![1]).toBe(GROUP);
    expect(sentTexts()[0]).toContain("Henry");
    expect(sentTexts()[0]).toContain("Stef");
    expect(deleteMessage).toHaveBeenCalledWith(huddleBot.client, GROUP, "r1");
    expect(row().rosterMsgId).toBe("new-msg");
  });

  it('aucun changement → publishRoster renvoie "unchanged", aucun envoi', async () => {
    seed(job());
    await tick(BEFORE_SLOT);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await tick(new Date(BEFORE_SLOT.getTime() + 60_000));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(claimRosterPublish).toHaveBeenCalledTimes(1);
  });

  it("la copie de la règle du job sert au filtre des événements, pas la règle live", async () => {
    const snapshot = rule({ whatsappGroupJid: "old@g.us", pinMessagesEnabled: true });
    liveRule = rule({ whatsappGroupJid: "new@g.us", pinMessagesEnabled: false, name: "Samedi live" });
    seed(job({ ruleSnapshot: snapshot }));
    graphState = { ...STAGES.awaitingGo, values: { ...STAGES.awaitingGo.values, bookingRule: snapshot } };

    await tick(BEFORE_SLOT);

    expect(listPollVoteEvents).toHaveBeenCalledWith(db, { chatJid: "old@g.us", pollMsgId: "poll-1" });
    expect(vi.mocked(sendMessage).mock.calls[0]![1]).toBe("old@g.us");
    expect(pinMessage).toHaveBeenCalledWith(huddleBot.client, "old@g.us", "new-msg", "7d");
  });

  it("B2-1 : nouveau job sans sondage → ancien roster intact, non arrêté (repris si le nouveau job disparaît)", async () => {
    seed(withRoster({ pollUnpinnedAt: BEFORE_SLOT }));
    graphState = STAGES.awaitingGo;
    events = [voteEvent("e1", "+332", "Stef", "10H30")];
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(job({ id: "job-2", pollMsgId: null }));

    await tick(BEFORE_SLOT);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(unpinMessage).not.toHaveBeenCalled();
    expect(row().rosterMsgId).toBe("r1");
    expect(row().rosterStoppedAt).toBeNull();

    // Nouveau job supprimé : l'ancien redevient le job actif, le roster repart.
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(row());
    await tick(new Date(BEFORE_SLOT.getTime() + 60_000));
    expect(sentTexts()[0]).toContain("Stef");
  });

  // B1-13 (a) adapté par B2-1 (décision de Vinz du 2026-10-25) : retrait seulement si le nouveau job a son sondage.
  it("B2-1 / B1-13 (a) : nouveau job avec sondage → provisoire retiré une seule fois, puis arrêté", async () => {
    // Sondage déjà désépinglé : seule la passe roster lit l'état du job.
    seed(withRoster({ pollUnpinnedAt: BEFORE_SLOT }));
    graphState = STAGES.awaitingGo;
    events = [voteEvent("e1", "+332", "Stef", "10H30")];
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(job({ id: "job-2", pollMsgId: "poll-2" }));

    await tick(BEFORE_SLOT);
    await tick(new Date(BEFORE_SLOT.getTime() + 60_000));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith(huddleBot.client, GROUP, "r1");
    expect(row().rosterMsgId).toBeNull();
    expect(row().rosterStoppedAt).toEqual(BEFORE_SLOT);
  });

  it("B2-1 : nouveau job avec sondage → définitif avec courts désépinglé, jamais supprimé, puis arrêté", async () => {
    seed(withRoster({ rosterFinal, pollUnpinnedAt: BEFORE_SLOT }));
    graphState = STAGES.announced;
    vi.mocked(findActiveJobRunForDate).mockResolvedValue(job({ id: "job-2", pollMsgId: "poll-2" }));

    await tick(BEFORE_SLOT);
    await tick(new Date(BEFORE_SLOT.getTime() + 60_000));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(unpinMessage).toHaveBeenCalledTimes(1);
    expect(unpinMessage).toHaveBeenCalledWith(huddleBot.client, GROUP, "r1");
    expect(row().rosterMsgId).toBe("r1");
    expect(row().rosterPinnedAt).toBeNull();
    expect(row().rosterStoppedAt).toEqual(BEFORE_SLOT);
  });

  it("lookup en échec : nom WhatsApp mémorisé, pas de republication au tick suivant", async () => {
    seed(job());
    events = [voteEvent("e1", "+332", "Stef", "10H30")];
    vi.mocked(lookupPlayerByPhone).mockRejectedValue(new Error("resa-squash KO"));

    await tick(BEFORE_SLOT);
    await tick(new Date(BEFORE_SLOT.getTime() + 60_000));

    expect(lookupPlayerByPhone).toHaveBeenCalledTimes(1);
    expect(row().rosterIdentities?.["tel:+332"]).toEqual({ userId: null, name: "Stef" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("triggerRosterRefresh — fin (CA-10) et retrait", () => {
  it("CA-10 : après le début du 1er créneau → aucune publication, roster désépinglé, roster_stopped_at écrit ; sondage désépinglé par la passe sondage", async () => {
    seed(withRoster({ rosterFinal }));
    graphState = STAGES.announced;
    events = [voteEvent("e1", "+332", "Stef", "10H30")];

    await tick(SLOT);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(unpinMessage).toHaveBeenCalledWith(huddleBot.client, GROUP, "r1");
    expect(row().rosterStoppedAt).toEqual(SLOT);
    expect(row().rosterMsgId).toBe("r1");
    expect(unpinMessage).toHaveBeenCalledWith(huddleBot.client, GROUP, "poll-1");
    expect(row().pollUnpinnedAt).toEqual(SLOT);
  });

  it("avant le 1er créneau, finished-announced avec rosterFinal → définitif republié", async () => {
    seed(withRoster({ rosterFinal }));
    graphState = STAGES.announced;
    events = [voteEvent("e1", "+332", "Stef", "10H30")];

    await tick(BEFORE_SLOT);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sentTexts()[0]).toContain("Court 4 : 10h30");
    expect(row().rosterStoppedAt).toBeNull();
    expect(unpinMessage).not.toHaveBeenCalledWith(huddleBot.client, GROUP, "poll-1");
  });

  it("CA-10 : désépinglage du roster en échec à la fin → orphelin mémorisé, retenté ensuite", async () => {
    seed(withRoster({ rosterFinal }));
    graphState = STAGES.announced;
    vi.mocked(unpinMessage).mockImplementation(async (_c, _jid, msgId) => {
      if (msgId === "r1") throw new Error("unpin KO");
    });

    await tick(SLOT);

    expect(row().rosterStoppedAt).toEqual(SLOT);
    expect(row().rosterOrphan).toMatchObject({ msgId: "r1", jid: GROUP });
    expect(sendTelegramMessage).toHaveBeenCalled();

    vi.mocked(unpinMessage).mockResolvedValue(undefined);
    await tick(new Date(SLOT.getTime() + 60_000));

    expect(row().rosterOrphan).toBeNull();
    expect(pinMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("firstReservedSlotMinutes null → traité comme fin sans réservation", async () => {
    seed(withRoster());
    graphState = {
      next: [],
      values: { ...STAGES.announced.values, reservationFailures: [{ sessionId: "s1", reason: "KO" }] },
    };

    await tick(BEFORE_SLOT);

    expect(deleteMessage).toHaveBeenCalledWith(huddleBot.client, GROUP, "r1");
    expect(row().rosterMsgId).toBeNull();
    expect(row().rosterStoppedAt).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("finished-no-plan → roster provisoire retiré (withdrawRoster)", async () => {
    seed(withRoster());
    graphState = STAGES.noPlan;

    await tick(BEFORE_SLOT);

    expect(deleteMessage).toHaveBeenCalledWith(huddleBot.client, GROUP, "r1");
    expect(row().rosterMsgId).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("B1-7 (décision du 2026-10-25) : error sans rosterFinal → rien, ni retrait ni publication", async () => {
    seed(withRoster());
    graphState = STAGES.error;
    events = [voteEvent("e1", "+332", "Stef", "10H30")];

    await tick(BEFORE_SLOT);

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(row().rosterMsgId).toBe("r1");
    expect(row().rosterStoppedAt).toBeNull();
  });

  it("B1-7 : error sans rosterFinal puis date passée → roster retiré puis arrêté", async () => {
    seed(withRoster());
    graphState = STAGES.error;
    const nextDay = atParis(8 * 60, 1);

    await tick(BEFORE_SLOT);
    await tick(nextDay);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith(huddleBot.client, GROUP, "r1");
    expect(row().rosterMsgId).toBeNull();
    expect(row().rosterStoppedAt).toEqual(nextDay);
  });

  it("error avec rosterFinal → définitif republié, jamais retiré", async () => {
    seed(withRoster({ rosterFinal }));
    graphState = STAGES.error;
    events = [voteEvent("e1", "+332", "Stef", "10H30")];

    await tick(BEFORE_SLOT);
    await tick(new Date(BEFORE_SLOT.getTime() + 60_000));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sentTexts()[0]).toContain("Court 4 : 10h30");
    expect(row().rosterMsgId).toBe("new-msg");
  });

  it("error avec rosterFinal → arrêt au premier créneau", async () => {
    seed(withRoster({ rosterFinal }));
    graphState = STAGES.error;

    await tick(SLOT);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(unpinMessage).toHaveBeenCalledWith(huddleBot.client, GROUP, "r1");
    expect(row().rosterStoppedAt).toEqual(SLOT);
    expect(row().rosterMsgId).toBe("r1");
  });

  it("error avec rosterFinal sans créneau lisible → arrêt à 23h59", async () => {
    seed(withRoster({ rosterFinal }));
    graphState = { next: ["announce"], values: { pollRequestId: "p", goConfirmed: true, bookingPlanGroups: [] } };

    await tick(atParis(23 * 60 + 58));
    expect(row().rosterStoppedAt).toBeNull();

    await tick(atParis(23 * 60 + 59));
    expect(row().rosterStoppedAt).toEqual(atParis(23 * 60 + 59));
  });

  it("Recalculer depuis finished-cancelled → awaiting-go → provisoire republié", async () => {
    seed(withRoster());
    graphState = STAGES.cancelled;
    await tick(BEFORE_SLOT);
    expect(row().rosterMsgId).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();

    graphState = STAGES.awaitingGo;
    await tick(new Date(BEFORE_SLOT.getTime() + 60_000));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sentTexts()[0]).toContain("Henry");
    expect(row().rosterMsgId).toBe("new-msg");
  });

  it("B1-13 (b) : date passée, job resté en attente du go → roster retiré puis arrêté, plus épinglé", async () => {
    seed(withRoster());
    graphState = STAGES.awaitingGo;
    const nextDay = atParis(8 * 60, 1);

    await tick(nextDay);
    await tick(new Date(nextDay.getTime() + 60_000));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith(huddleBot.client, GROUP, "r1");
    expect(row().rosterMsgId).toBeNull();
    expect(row().rosterStoppedAt).toEqual(nextDay);
  });

  it("finished-announced avec rosterFinal, échec total (aucun court) → roster retiré", async () => {
    seed(withRoster({ rosterFinal }));
    graphState = {
      next: [],
      values: { ...STAGES.announced.values, reservationFailures: [{ sessionId: "s1", reason: "KO" }] },
    };

    await tick(BEFORE_SLOT);

    expect(deleteMessage).toHaveBeenCalledWith(huddleBot.client, GROUP, "r1");
    expect(row().rosterMsgId).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("B1-13 (c) : finished-announced avec rosterFinal sans créneau lisible → définitif gardé, arrêt à 23h59", async () => {
    seed(withRoster({ rosterFinal }));
    graphState = { next: [], values: { ...STAGES.announced.values, bookingPlanGroups: [slotGroup("illisible")] } };

    // Définitif republié (l'ancien roster est remplacé), pas retiré.
    await tick(BEFORE_SLOT);
    expect(sentTexts()[0]).toContain("Court 4 : 10h30");
    expect(row().rosterMsgId).toBe("new-msg");

    await tick(atParis(23 * 60 + 58));
    expect(row().rosterStoppedAt).toBeNull();

    await tick(atParis(23 * 60 + 59));
    expect(row().rosterStoppedAt).toEqual(atParis(23 * 60 + 59));
    expect(row().rosterMsgId).toBe("new-msg");
    expect(unpinMessage).toHaveBeenCalledWith(huddleBot.client, GROUP, "new-msg");
  });

  it("date passée : arrêt rattrapé sans publication", async () => {
    seed(withRoster({ rosterFinal }));
    graphState = STAGES.announced;

    await tick(atParis(8 * 60, 2));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(row().rosterStoppedAt).toEqual(atParis(8 * 60, 2));
  });
});

describe("triggerRosterRefresh — passes orphelin et sondage", () => {
  it("orphelin d'un job terminé → désépinglage retenté (C3-3)", async () => {
    const orphan = { msgId: "o1", jid: GROUP, expiresAt: new Date(SLOT.getTime() + 86_400_000).toISOString() };
    seed(withRoster({ rosterStoppedAt: SLOT, rosterOrphan: orphan, pollUnpinnedAt: SLOT }));
    graphState = STAGES.noPlan;

    await tick(atParis(12 * 60));

    expect(unpinMessage).toHaveBeenCalledWith(huddleBot.client, GROUP, "o1");
    expect(row().rosterOrphan).toBeNull();
    expect(pinMessage).not.toHaveBeenCalled();
  });

  it("passe sondage : job sans créneau → sondage désépinglé à 23h59", async () => {
    seed(job());
    graphState = STAGES.noPlan;

    await tick(atParis(23 * 60 + 58));
    expect(unpinMessage).not.toHaveBeenCalled();

    await tick(atParis(23 * 60 + 59));
    expect(unpinMessage).toHaveBeenCalledWith(huddleBot.client, GROUP, "poll-1");
    expect(row().pollUnpinnedAt).toEqual(atParis(23 * 60 + 59));
  });

  it("passe sondage : date passée → désépinglé au rattrapage ; échec → poll_unpinned_at non écrit", async () => {
    seed(job({ rosterStoppedAt: SLOT }));
    graphState = STAGES.announced;
    vi.mocked(unpinMessage).mockRejectedValue(new Error("unpin KO"));
    const later = atParis(9 * 60, 2);

    await tick(later);
    await tick(new Date(later.getTime() + 60_000));

    expect(unpinMessage).toHaveBeenCalledTimes(2);
    expect(row().pollUnpinnedAt).toBeNull();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);

    vi.mocked(unpinMessage).mockResolvedValue(undefined);
    const retry = new Date(later.getTime() + 120_000);
    await tick(retry);
    expect(row().pollUnpinnedAt).toEqual(retry);
  });

  it("passe sondage : épinglage désactivé ou match trop ancien → oublié sans appel huddle-bot", async () => {
    seed(
      job({ id: "no-pin", ruleSnapshot: rule({ pinMessagesEnabled: false }) }),
      job({ id: "stale", targetDate: "2026-09-30", rosterStoppedAt: SLOT }),
    );
    graphState = STAGES.noPlan;

    await tick(BEFORE_SLOT);

    expect(unpinMessage).not.toHaveBeenCalled();
    expect(row("no-pin").pollUnpinnedAt).toEqual(BEFORE_SLOT);
    expect(row("stale").pollUnpinnedAt).toEqual(BEFORE_SLOT);
  });

  it("un job en échec n'empêche pas les autres", async () => {
    seed(withRoster({ id: "job-a", bookingRuleId: "rule-a" }), job());
    vi.mocked(findActiveJobRunForDate).mockImplementation(async (_db, ruleId) => {
      if (ruleId === "rule-a") throw new Error("db KO");
      return row("job-1");
    });

    await tick(BEFORE_SLOT);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(row("job-1").rosterMsgId).toBe("new-msg");
  });
});
