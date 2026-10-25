import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingRule, JobRun } from "@squash-assistant/db/schema";
import type { Identities, VoteEventRow, VotePhoto } from "@squash-assistant/db/rosterTypes";
import type { GraphDependencies } from "../graph/dependencies.js";

vi.mock("../mcp/resaSquash.js", () => ({ lookupPlayerByPhone: vi.fn() }));
vi.mock("../telegram/telegram.js", () => ({ sendTelegramMessage: vi.fn(async () => {}) }));
vi.mock("./rosterStore.js", () => ({
  listPollVoteEvents: vi.fn(async () => []),
  mergeRosterIdentities: vi.fn(async () => {}),
}));

const { refreshVotesFromEvents, __resetRefreshVotesTelegramLogForTests } = await import("./refreshVotes.js");
const { lookupPlayerByPhone } = await import("../mcp/resaSquash.js");
const { sendTelegramMessage } = await import("../telegram/telegram.js");
const { listPollVoteEvents, mergeRosterIdentities } = await import("./rosterStore.js");

const deps = {
  db: {} as never,
  resaSquash: { client: {} as never, close: async () => {} },
  telegram: { botToken: "t", chatId: "c" },
} as unknown as Pick<GraphDependencies, "db" | "resaSquash" | "telegram">;

const GROUP = "group@g.us";
const rule = { id: "rule-1", whatsappGroupJid: GROUP, candidateStartTimes: ["9H00", "10H30"] } as BookingRule;
const NOW = new Date("2026-10-25T18:00:00.000Z");

const photo: VotePhoto = {
  capturedAt: "2026-10-24T10:00:00.000Z",
  integratedEventIds: ["e0"],
  voters: [
    { key: "tel:+331", phone: "+331", waName: "Henry", option: "9H00", votedAt: 1000 },
    { key: "tel:+335", phone: "+335", waName: "Nono", option: "Non", votedAt: 1500 },
    { key: "nom:Sans Tel", phone: null, waName: "Sans Tel", option: "Non", votedAt: 1600 },
  ],
};
const baseIdentities: Identities = { "tel:+331": { userId: "u-henry", name: "Henry" } };

function job(overrides: Partial<JobRun> = {}): JobRun {
  return { id: "job-1", pollMsgId: "poll-msg", rosterPhoto: photo, rosterIdentities: baseIdentities, ...overrides } as JobRun;
}

function event(overrides: Partial<VoteEventRow>): VoteEventRow {
  return {
    eventId: "e1",
    eventType: "poll_vote_creation",
    createdAt: new Date(3000),
    occurredAt: new Date(3000),
    actorPhone: "+332",
    actorJid: "332@s.whatsapp.net",
    actorName: "Stef",
    selectedOptions: ["10H30"],
    previousOptions: [],
    ...overrides,
  };
}

/** Identités telles que la base les aurait après les fusions `keep` capturées (la base gagne). */
function identitiesAfterKeepMerges(start: Identities): Identities {
  return vi
    .mocked(mergeRosterIdentities)
    .mock.calls.reduce<Identities>((acc, [, , patch]) => ({ ...(patch as Identities), ...acc }), start);
}

describe("refreshVotesFromEvents (spec roster vivant §4.3, CA-2)", () => {
  beforeEach(() => {
    vi.mocked(lookupPlayerByPhone).mockReset();
    vi.mocked(sendTelegramMessage).mockClear();
    vi.mocked(listPollVoteEvents).mockReset().mockResolvedValue([]);
    vi.mocked(mergeRosterIdentities).mockClear();
    __resetRefreshVotesTelegramLogForTests();
  });

  it("job legacy (roster_photo nul) : null, aucune lecture", async () => {
    expect(await refreshVotesFromEvents(deps, job({ rosterPhoto: null }), rule, "Samedi", NOW)).toBeNull();
    expect(listPollVoteEvents).not.toHaveBeenCalled();
  });

  it("CA-2 : un oui arrivé après la collecte est dans confirmedPlayerIdsByTime, snapshot tPlan/état/event_id", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([event({ eventId: "e0" }), event({ eventId: "e1" })]);
    vi.mocked(lookupPlayerByPhone).mockResolvedValue({ found: true, userId: "u-stef", firstName: "Stéphane", nickname: "Stef" });

    const result = await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);

    expect(listPollVoteEvents).toHaveBeenCalledWith(deps.db, { chatJid: GROUP, pollMsgId: "poll-msg" });
    expect(result!.resolved.confirmedPlayerIdsByTime).toEqual({ "9H00": ["u-henry"], "10H30": ["u-stef"] });
    expect(result!.resolved.voterNames).toEqual({ "u-henry": "Henry", "u-stef": "Stef" });
    expect(result!.snapshot).toEqual({
      tPlan: NOW.toISOString(),
      state: {
        "tel:+331": { option: "9H00", lastAt: 1000 },
        "tel:+335": { option: null, lastAt: 1500 },
        "nom:Sans Tel": { option: null, lastAt: 1600 },
        "tel:+332": { option: "10H30", lastAt: 3000 },
      },
      integratedEventIds: ["e0", "e1"],
    });
    expect(mergeRosterIdentities).toHaveBeenCalledWith(deps.db, "job-1", { "tel:+332": { userId: "u-stef", name: "Stef" } }, "keep");
  });

  it("lookup seulement pour un votant nouveau ; un échec mémorise le nom WhatsApp", async () => {
    // Henry (déjà identifié) change d'heure ; Nono (« Non » à la collecte, absent d'identities) ne revote pas ;
    // Stef est nouveau et inconnu de resa-squash.
    vi.mocked(listPollVoteEvents).mockResolvedValue([
      event({ eventId: "e1", actorPhone: "+331", actorName: "Henry", selectedOptions: ["10H30"], previousOptions: ["9H00"] }),
      event({ eventId: "e2", occurredAt: new Date(4000) }),
    ]);
    vi.mocked(lookupPlayerByPhone).mockResolvedValue({ found: false });

    const first = await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);
    const second = await refreshVotesFromEvents(
      deps,
      job({ rosterIdentities: identitiesAfterKeepMerges(baseIdentities) }),
      rule,
      "Samedi",
      NOW,
    );

    expect(lookupPlayerByPhone).toHaveBeenCalledTimes(1);
    expect(lookupPlayerByPhone).toHaveBeenCalledWith(deps.resaSquash.client, "+332");
    expect(mergeRosterIdentities).toHaveBeenCalledTimes(1);
    expect(mergeRosterIdentities).toHaveBeenCalledWith(deps.db, "job-1", { "tel:+332": { userId: null, name: "Stef" } }, "keep");
    for (const result of [first, second]) {
      expect(result!.resolved.confirmedPlayerIdsByTime).toEqual({ "9H00": [], "10H30": ["u-henry"] });
      expect(result!.resolved.unresolvedVoters).toEqual([{ name: "Stef", phone: "+332", option: "10H30" }]);
    }
  });

  it("lookup en échec (panne) : nom WhatsApp de la photo à défaut d'actorName, jamais le téléphone (B1-1)", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([
      event({ eventId: "e1", actorPhone: "+335", actorName: null, selectedOptions: ["9H00"], previousOptions: ["Non"] }),
      event({ eventId: "e2", actorPhone: "+339", actorName: null }),
    ]);
    vi.mocked(lookupPlayerByPhone).mockRejectedValue(new Error("resa down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);

    expect(mergeRosterIdentities).toHaveBeenCalledWith(
      deps.db,
      "job-1",
      { "tel:+335": { userId: null, name: "Nono" }, "tel:+339": { userId: null, name: "" } },
      "keep",
    );
    warn.mockRestore();
  });

  it("identifié sans pseudo ni prénom, sans actorName : nom vide, jamais le téléphone (B1-1)", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([event({ eventId: "e2", actorPhone: "+339", actorName: null })]);
    vi.mocked(lookupPlayerByPhone).mockResolvedValue({ found: true, userId: "u-9", firstName: "", nickname: "" } as never);

    await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);

    expect(mergeRosterIdentities).toHaveBeenCalledWith(deps.db, "job-1", { "tel:+339": { userId: "u-9", name: "" } }, "keep");
  });

  it("clés nom: et jid: sans identité : nom rempli sans lookup", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([
      // Rapproché par nom de la photo (« Non » qui revote) → clé nom:Sans Tel.
      event({ eventId: "e1", actorPhone: null, actorJid: "1@lid", actorName: "Sans Tel", selectedOptions: ["9H00"], previousOptions: ["Non"] }),
      // Ni téléphone ni nom rapproché → clé jid:, nom = actorName.
      event({ eventId: "e2", actorPhone: null, actorJid: "2@lid", actorName: "Inconnu" }),
      event({ eventId: "e3", actorPhone: null, actorJid: "3@lid", actorName: null, occurredAt: new Date(5000) }),
    ]);

    const result = await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);

    expect(lookupPlayerByPhone).not.toHaveBeenCalled();
    expect(mergeRosterIdentities).toHaveBeenCalledWith(
      deps.db,
      "job-1",
      {
        "nom:Sans Tel": { userId: null, name: "Sans Tel" },
        "jid:2@lid": { userId: null, name: "Inconnu" },
        "jid:3@lid": { userId: null, name: "" },
      },
      "keep",
    );
    expect(result!.resolved.unresolvedVoters).toEqual([
      { name: "Sans Tel", phone: null, option: "9H00" },
      { name: "Inconnu", phone: null, option: "10H30" },
      { name: "", phone: null, option: "10H30" },
    ]);
  });

  it("R1-4 : identifié par Recalculer → reste identifié après le recalcul des votes", async () => {
    // « Recalculer » a écrit (override) l'identité de Stef ; ses votes sont rejoués ensuite.
    vi.mocked(listPollVoteEvents).mockResolvedValue([event({ eventId: "e1" })]);
    const identities = { ...baseIdentities, "tel:+332": { userId: "u-stef", name: "Stef" } };

    const result = await refreshVotesFromEvents(deps, job({ rosterIdentities: identities }), rule, "Samedi", NOW);

    expect(lookupPlayerByPhone).not.toHaveBeenCalled();
    expect(mergeRosterIdentities).not.toHaveBeenCalled();
    expect(result!.resolved.confirmedPlayerIdsByTime["10H30"]).toEqual(["u-stef"]);
    expect(result!.resolved.unresolvedVoters).toEqual([]);
  });

  it("faux retrait et @lid non rapproché : un Telegram par event_id, pas à chaque passe", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([
      event({ eventId: "e-suspect", actorPhone: "+331", actorName: "Henry", actorJid: "331@s.whatsapp.net", selectedOptions: [], previousOptions: [] }),
      event({ eventId: "e-lid", actorPhone: null, actorJid: "99@lid", actorName: "Mystère" }),
    ]);

    await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);
    await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);

    const texts = vi.mocked(sendTelegramMessage).mock.calls.map(([, text]) => text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("Henry");
    expect(texts[0]).toContain("331@s.whatsapp.net");
    expect(texts[1]).toContain("Mystère");
    expect(texts[1]).toContain("99@lid");
  });
});
