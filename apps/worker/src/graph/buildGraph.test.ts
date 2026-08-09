import { END } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { afterSendPoll } from "./buildGraph.js";

describe("afterSendPoll", () => {
  it("termine le graphe lorsque le club est fermé", () => {
    expect(afterSendPoll({ clubClosed: true } as never)).toBe(END);
  });

  it("poursuit vers l'attente de décision lorsqu'un sondage a été envoyé", () => {
    expect(afterSendPoll({ clubClosed: false } as never)).toBe("waitForDecisionWindow");
  });
});
