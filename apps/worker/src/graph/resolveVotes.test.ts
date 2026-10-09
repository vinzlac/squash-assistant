import { describe, expect, it, vi } from "vitest";
import type { GraphDependencies } from "./dependencies.js";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "./nodes/pollQuestion.js";

vi.mock("../mcp/huddleBot.js", () => ({ getResponses: vi.fn() }));
vi.mock("../mcp/resaSquash.js", () => ({ lookupPlayerByPhone: vi.fn() }));

const { resolveVotes } = await import("./resolveVotes.js");
const { getResponses } = await import("../mcp/huddleBot.js");
const { lookupPlayerByPhone } = await import("../mcp/resaSquash.js");

const deps = {
  huddleBot: { client: {} as never, close: async () => {} },
  resaSquash: { client: {} as never, close: async () => {} },
} as unknown as GraphDependencies;

describe("resolveVotes — votants non identifiés (spec 2026-10-09 §3.2)", () => {
  it("garde nom, téléphone et option des non-identifiés ; votant sans téléphone conservé avec phone null", async () => {
    vi.mocked(getResponses).mockResolvedValue({
      requestId: "poll-1",
      type: "poll",
      responses: [
        { member: "Hugo MERCIER", phone: "33600000001", statut: "10H30" },
        { member: "Vince", phone: "33663892186", statut: SUBSTITUTE_VOLUNTEER_POLL_OPTION },
        { member: "Sans Tel", phone: null, statut: "10H30" },
        { member: "Paul", phone: "33600000003", statut: "non" },
      ],
    });
    vi.mocked(lookupPlayerByPhone).mockImplementation(async (_client, phone) =>
      phone === "+33600000001" ? { found: true, userId: "u-hugo", firstName: "Hugues", lastName: "MERCIER", nickname: "Hugo" } : { found: false },
    );

    const result = await resolveVotes(deps, "poll-1", ["10H30"]);

    expect(result).toEqual({
      confirmedPlayerIdsByTime: { "10H30": ["u-hugo"] },
      volunteerSubstituteIds: [],
      unresolvedVoters: [
        { name: "Vince", phone: "+33663892186", option: SUBSTITUTE_VOLUNTEER_POLL_OPTION },
        { name: "Sans Tel", phone: null, option: "10H30" },
      ],
      voterNames: { "u-hugo": "Hugo" },
      respondentCount: 4,
    });
    expect(lookupPlayerByPhone).toHaveBeenCalledTimes(2);
  });

  it("pseudo absent (MCP antérieur au pseudo) : prénom seul, jamais le nom de famille", async () => {
    vi.mocked(getResponses).mockResolvedValue({
      requestId: "poll-1",
      type: "poll",
      responses: [{ member: "Hugo", phone: "33600000001", statut: "10H30" }],
    });
    vi.mocked(lookupPlayerByPhone).mockResolvedValue({ found: true, userId: "u-hugo", firstName: "Hugo", lastName: "MERCIER" });

    const result = await resolveVotes(deps, "poll-1", ["10H30"]);

    expect(result.voterNames).toEqual({ "u-hugo": "Hugo" });
  });

  it("votant identifié sans nom renvoyé par resa-squash : absent de voterNames (jamais d'id à la place)", async () => {
    vi.mocked(getResponses).mockResolvedValue({
      requestId: "poll-1",
      type: "poll",
      responses: [{ member: "Hugo", phone: "33600000001", statut: "10H30" }],
    });
    vi.mocked(lookupPlayerByPhone).mockResolvedValue({ found: true, userId: "u-hugo" });

    const result = await resolveVotes(deps, "poll-1", ["10H30"]);

    expect(result.voterNames).toEqual({});
  });

  it("respondentCount : tout statut sauf « aucune_reponse » (heure, prête-nom, non, ambigu) ; 0 si personne n'a répondu", async () => {
    vi.mocked(lookupPlayerByPhone).mockResolvedValue({ found: false });
    vi.mocked(getResponses).mockResolvedValue({
      requestId: "poll-1",
      type: "poll",
      responses: [
        { member: "A", phone: "33600000001", statut: "10H30" },
        { member: "B", phone: "33600000002", statut: "non" },
        { member: "C", phone: "33600000003", statut: "ambigu" },
        { member: "D", phone: "33600000004", statut: "aucune_reponse" },
        { member: "E", phone: "33600000005", statut: "aucune_reponse" },
      ],
    });
    expect((await resolveVotes(deps, "poll-1", ["10H30"])).respondentCount).toBe(3);

    vi.mocked(getResponses).mockResolvedValue({
      requestId: "poll-1",
      type: "poll",
      responses: [
        { member: "D", phone: "33600000004", statut: "aucune_reponse" },
        { member: "E", phone: null, statut: "aucune_reponse" },
      ],
    });
    expect((await resolveVotes(deps, "poll-1", ["10H30"])).respondentCount).toBe(0);
  });
});
