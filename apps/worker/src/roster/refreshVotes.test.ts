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

  it("B1-4 : votant tardif inconnu de resa-squash → 1 Telegram au format des non-identifiés ; 2e passe → aucun nouveau", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([event({ eventId: "e1" })]);
    vi.mocked(lookupPlayerByPhone).mockResolvedValue({ found: false });

    await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);
    // 2e passe sans identité en base : la déduplication en mémoire (clé + job) suffit.
    await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);

    const texts = vi.mocked(sendTelegramMessage).mock.calls.map(([, text]) => text);
    expect(texts).toEqual([
      "[Samedi] ⚠️ 1 votant(s) non identifié(s) — impossible de savoir qui c'est, exclu(s) du plan :\n" +
        "  • Stef (+332, numéro inconnu de resa-squash) — « 10H30 »\n" +
        "→ Associer ce numéro à leur compte TeamR/resa-squash, puis « Recalculer le plan » avant le go.",
    ]);
  });

  it("B1-4 : recherche en échec → la cause le dit", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([event({ eventId: "e1" })]);
    vi.mocked(lookupPlayerByPhone).mockRejectedValue(new Error("resa down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);

    const texts = vi.mocked(sendTelegramMessage).mock.calls.map(([, text]) => text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("  • Stef (+332, recherche en échec (resa down)) — « 10H30 »");
    warn.mockRestore();
  });

  it("B1-4 : votant tardif identifié → aucun Telegram", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([event({ eventId: "e1" })]);
    vi.mocked(lookupPlayerByPhone).mockResolvedValue({ found: true, userId: "u-stef", firstName: "Stéphane", nickname: "Stef" });

    await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);

    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("B2-2 : clé nom: rapprochée par nom mais événement avec téléphone → recherche avec ce téléphone, Telegram B1-4 si inconnu", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([
      // « Non » de la photo sans téléphone qui revote avec un téléphone : clé nom:Sans Tel (B1-2).
      event({ eventId: "e1", actorPhone: "+339", actorJid: "339@s.whatsapp.net", actorName: "Sans Tel", selectedOptions: ["9H00"], previousOptions: ["Non"] }),
    ]);
    vi.mocked(lookupPlayerByPhone).mockResolvedValue({ found: false });

    await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);

    expect(lookupPlayerByPhone).toHaveBeenCalledTimes(1);
    expect(vi.mocked(lookupPlayerByPhone).mock.calls[0]![1]).toBe("+339");
    expect(mergeRosterIdentities).toHaveBeenCalledWith(deps.db, "job-1", { "nom:Sans Tel": { userId: null, name: "Sans Tel" } }, "keep");
    const texts = vi.mocked(sendTelegramMessage).mock.calls.map(([, text]) => text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("  • Sans Tel (+339, numéro inconnu de resa-squash) — « 9H00 »");
  });

  it("B2-2 : clé nom: avec téléphone connu de resa-squash → identifiée", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([
      event({ eventId: "e1", actorPhone: "+339", actorJid: "339@s.whatsapp.net", actorName: "Sans Tel", selectedOptions: ["9H00"], previousOptions: ["Non"] }),
    ]);
    vi.mocked(lookupPlayerByPhone).mockResolvedValue({ found: true, userId: "u-st", firstName: "Sam", nickname: "Sam" });

    const result = await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);

    expect(result!.resolved.confirmedPlayerIdsByTime["9H00"]).toContain("u-st");
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("B2-4 : Telegram B1-4 en échec → clé libérée, renvoyé à la passe suivante", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([event({ eventId: "e1" })]);
    vi.mocked(lookupPlayerByPhone).mockResolvedValue({ found: false });
    vi.mocked(sendTelegramMessage).mockRejectedValueOnce(new Error("telegram KO"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);
    await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);
    await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);

    expect(sendTelegramMessage).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("B2-4 : deux passes concurrentes → un seul Telegram B1-4 (clé réservée avant l'envoi)", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([event({ eventId: "e1" })]);
    vi.mocked(lookupPlayerByPhone).mockResolvedValue({ found: false });

    await Promise.all([
      refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW),
      refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW),
    ]);

    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("Telegram de retrait en échec : renvoyé à la passe suivante", async () => {
    vi.mocked(listPollVoteEvents).mockResolvedValue([
      event({ eventId: "e-retry", actorPhone: "+331", actorName: "Henry", actorJid: "331@s.whatsapp.net", selectedOptions: [], previousOptions: [] }),
    ]);
    vi.mocked(sendTelegramMessage).mockRejectedValueOnce(new Error("telegram down"));

    await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);
    await refreshVotesFromEvents(deps, job(), rule, "Samedi", NOW);

    expect(sendTelegramMessage).toHaveBeenCalledTimes(2);
  });

  it("retrait vide et @lid non rapproché : un Telegram par event_id, pas à chaque passe", async () => {
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
    expect(texts[0]).toContain("avait 9H00");
    expect(texts[1]).toContain("Mystère");
    expect(texts[1]).toContain("99@lid");
  });
});
