import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../mcp/resaSquash.js", () => ({ getBookingQr: vi.fn() }));
vi.mock("../mcp/huddleBot.js", () => ({ sendImage: vi.fn() }));

const { selectQrBookings, sendBookingQrCodes } = await import("./bookingQr.js");
const { getBookingQr } = await import("../mcp/resaSquash.js");
const { sendImage } = await import("../mcp/huddleBot.js");

const deps = { resaSquash: { client: {} }, huddleBot: { client: {} } } as never;

function booking(sessionId: string, court: number, slotTime: string) {
  return { sessionId, court, slotTime };
}

describe("selectQrBookings", () => {
  it("garde un seul créneau par court : le plus tôt", () => {
    const selected = selectQrBookings([
      booking("s2", 1, "11H15"),
      booking("s1", 1, "10H30"),
      booking("s3", 2, "11H15"),
      booking("s4", 2, "10H30"),
    ]);
    expect(selected.map((b) => b.sessionId)).toEqual(["s1", "s4"]);
  });

  it("trie par numéro de court", () => {
    const selected = selectQrBookings([booking("s1", 3, "10H30"), booking("s2", 1, "10H30")]);
    expect(selected.map((b) => b.court)).toEqual([1, 3]);
  });

  it("retourne vide sans réservation", () => {
    expect(selectQrBookings([])).toEqual([]);
  });
});

describe("sendBookingQrCodes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("envoie un QR par court, avec la légende de resa-squash", async () => {
    vi.mocked(getBookingQr).mockImplementation(async (_client, sessionId) => ({
      found: true,
      qrAvailable: true,
      url: `https://resa.test/qr/${sessionId}`,
      caption: `Court pour ${sessionId}`,
    }));

    const sent = await sendBookingQrCodes(deps, "group@test", [
      booking("s1", 1, "10H30"),
      booking("s2", 1, "11H15"),
      booking("s3", 2, "10H30"),
    ]);

    expect(sent).toBe(2);
    expect(sendImage).toHaveBeenCalledTimes(2);
    expect(sendImage).toHaveBeenNthCalledWith(1, {}, "group@test", "https://resa.test/qr/s1", "Court pour s1");
    expect(sendImage).toHaveBeenNthCalledWith(2, {}, "group@test", "https://resa.test/qr/s3", "Court pour s3");
  });

  it("saute un court sans QR disponible sans rien envoyer pour lui", async () => {
    vi.mocked(getBookingQr).mockResolvedValue({ found: true, qrAvailable: false });

    const sent = await sendBookingQrCodes(deps, "group@test", [booking("s1", 1, "10H30")]);

    expect(sent).toBe(0);
    expect(sendImage).not.toHaveBeenCalled();
  });

  it("continue sur les autres courts quand un appel échoue (best-effort)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getBookingQr).mockImplementation(async (_client, sessionId) => {
      if (sessionId === "s1") throw new Error("resa-squash KO");
      return { found: true, url: "https://resa.test/qr/s3", caption: "Court 2" };
    });

    const sent = await sendBookingQrCodes(deps, "group@test", [booking("s1", 1, "10H30"), booking("s3", 2, "10H30")]);

    expect(sent).toBe(1);
    expect(sendImage).toHaveBeenCalledOnce();
    consoleErrorSpy.mockRestore();
  });
});
