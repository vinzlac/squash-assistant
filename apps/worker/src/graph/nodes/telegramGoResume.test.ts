import { describe, expect, it } from "vitest";
import { resumeValueForTelegramGo } from "./telegramGoResume.js";

describe("resumeValueForTelegramGo", () => {
  it("job auto + go → go-real", () => {
    expect(resumeValueForTelegramGo({ auto: true }, true)).toBe("go-real");
  });

  it("job manuel + go → go (dry-run)", () => {
    expect(resumeValueForTelegramGo({ auto: false }, true)).toBe("go");
  });

  it("pas de confirmation → timeout", () => {
    expect(resumeValueForTelegramGo({ auto: true }, false)).toBe("timeout");
    expect(resumeValueForTelegramGo({ auto: false }, false)).toBe("timeout");
  });
});
