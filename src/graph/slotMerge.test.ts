import { describe, expect, it } from "vitest";
import { formatMergedCourtSlots, mergeContiguousSlotsByCourt } from "./slotMerge.js";

describe("mergeContiguousSlotsByCourt", () => {
  it("fusionne deux créneaux contigus sur le même court", () => {
    const merged = mergeContiguousSlotsByCourt([
      { court: 2, beginTime: "18:45:00", endTime: "19:30:00" },
      { court: 2, beginTime: "19:30:00", endTime: "20:15:00" },
    ]);
    expect(merged).toEqual([{ court: 2, beginTime: "18:45:00", endTime: "20:15:00" }]);
  });

  it("ne fusionne pas des créneaux non contigus", () => {
    const merged = mergeContiguousSlotsByCourt([
      { court: 2, beginTime: "18:45:00", endTime: "19:30:00" },
      { court: 2, beginTime: "20:15:00", endTime: "21:00:00" },
    ]);
    expect(merged).toHaveLength(2);
  });

  it("traite chaque court indépendamment", () => {
    const merged = mergeContiguousSlotsByCourt([
      { court: 3, beginTime: "19:30:00", endTime: "20:15:00" },
      { court: 4, beginTime: "19:30:00", endTime: "20:15:00" },
    ]);
    expect(merged).toEqual([
      { court: 3, beginTime: "19:30:00", endTime: "20:15:00" },
      { court: 4, beginTime: "19:30:00", endTime: "20:15:00" },
    ]);
  });
});

describe("formatMergedCourtSlots", () => {
  it("formate au format « Court X : HHhMM-HHhMM »", () => {
    const text = formatMergedCourtSlots([{ court: 2, beginTime: "18:45:00", endTime: "20:15:00" }]);
    expect(text).toBe("Court 2 : 18H45-20H15");
  });
});
