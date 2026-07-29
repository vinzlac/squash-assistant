import { describe, expect, it, vi } from "vitest";

const callToolMock = vi.fn();
vi.mock("./client.js", () => ({
  callTool: (...args: unknown[]) => callToolMock(...args),
}));

const { listAvailability, listMyReservationsOnDate } = await import("./resaSquash.js");

describe("listAvailability", () => {
  it("transmet dateFrom/dateTo/courts et renvoie le payload tel quel", async () => {
    const payload = {
      dateFrom: "2026-08-04",
      dateTo: "2026-08-04",
      availability: [
        {
          date: "2026-08-04",
          slots: [
            {
              id: "sess-1",
              court: 4,
              time: "18H45",
              endTime: "19H30",
              date: "2026-08-04",
              participants: 0,
              available: true,
              users: [],
            },
          ],
        },
      ],
    };
    callToolMock.mockResolvedValueOnce(payload);

    const result = await listAvailability({} as never, "2026-08-04", "2026-08-04", [4]);

    expect(callToolMock).toHaveBeenCalledWith({}, "list_availability", {
      dateFrom: "2026-08-04",
      dateTo: "2026-08-04",
      courts: [4],
    });
    expect(result).toEqual(payload);
  });
});

describe("listMyReservationsOnDate", () => {
  it("transmet onDate/timeZone et renvoie userId + reservations", async () => {
    const payload = { userId: "api-user-1", onDate: "2026-08-04", timeZone: "Europe/Paris", reservations: [] };
    callToolMock.mockResolvedValueOnce(payload);

    const result = await listMyReservationsOnDate({} as never, "2026-08-04", "Europe/Paris");

    expect(callToolMock).toHaveBeenCalledWith({}, "list_my_reservations_on_date", {
      onDate: "2026-08-04",
      timeZone: "Europe/Paris",
    });
    expect(result.userId).toBe("api-user-1");
  });
});
