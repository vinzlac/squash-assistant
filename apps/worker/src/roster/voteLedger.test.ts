import { describe, expect, it } from "vitest";
import type { VoteEventRow, VotePhoto } from "@squash-assistant/db/rosterTypes";
import { SUBSTITUTE_VOLUNTEER_POLL_OPTION } from "../graph/nodes/pollQuestion.js";
import { applyVoteEvents, eventVoterKey, normalizePhone, photoState, photoVoterKey, toResolvedVotes } from "./voteLedger.js";

const CANDIDATES = ["9H00", "10H30"];

const photo: VotePhoto = {
  capturedAt: "2026-10-24T10:00:00.000Z",
  integratedEventIds: [],
  voters: [
    { key: "tel:+331", phone: "+331", waName: "Henry", option: "9H00", votedAt: 1000 },
    { key: "tel:+332", phone: "+332", waName: "Stef", option: "9H00", votedAt: 2000 },
  ],
};
const from = { state: photoState(photo, CANDIDATES), integratedEventIds: [] as string[] };

function event(overrides: Partial<VoteEventRow>): VoteEventRow {
  return {
    eventId: "e1",
    eventType: "poll_vote_updated",
    createdAt: new Date(3000),
    occurredAt: new Date(3000),
    actorPhone: "+331",
    actorJid: "331@s.whatsapp.net",
    actorName: "Henry",
    selectedOptions: [],
    previousOptions: ["9H00"],
    ...overrides,
  };
}

describe("normalizePhone / photoVoterKey", () => {
  it("garde les chiffres et préfixe +", () => {
    expect(normalizePhone("+33 6 12-34")).toBe("+33612" + "34");
    expect(normalizePhone("  ")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
  it("clé tel: si téléphone, sinon nom:", () => {
    expect(photoVoterKey("+331", "Henry")).toBe("tel:+331");
    expect(photoVoterKey(null, "Henry")).toBe("nom:Henry");
  });
});

describe("photoState", () => {
  it("option hors heures candidates et hors prête-nom donne null, prête-nom conservé", () => {
    const state = photoState(
      {
        ...photo,
        voters: [
          { key: "tel:+1", phone: "+1", waName: "A", option: "Non", votedAt: 5 },
          { key: "tel:+2", phone: "+2", waName: "B", option: SUBSTITUTE_VOLUNTEER_POLL_OPTION, votedAt: 6 },
          { key: "tel:+3", phone: "+3", waName: "C", option: "10H30", votedAt: null },
        ],
      },
      CANDIDATES,
    );
    expect(state["tel:+1"]).toEqual({ option: null, lastAt: 5 });
    expect(state["tel:+2"]).toEqual({ option: SUBSTITUTE_VOLUNTEER_POLL_OPTION, lastAt: 6 });
    expect(state["tel:+3"]).toEqual({ option: "10H30", lastAt: null });
  });
});

describe("eventVoterKey", () => {
  it("téléphone d'abord", () => {
    expect(eventVoterKey(event({ actorPhone: "331" }), photo)).toEqual({ key: "tel:+331", matchedBy: "phone" });
  });
  it("sinon nom de la photo (trim)", () => {
    expect(eventVoterKey(event({ actorPhone: null, actorName: " Stef " }), photo)).toEqual({ key: "tel:+332", matchedBy: "name" });
  });
  it("sinon jid", () => {
    expect(eventVoterKey(event({ actorPhone: null, actorName: null, actorJid: "x@lid" }), photo)).toEqual({ key: "jid:x@lid", matchedBy: "jid" });
  });
});

describe("applyVoteEvents", () => {
  it("retrait : selectedOptions [] → option null", () => {
    const r = applyVoteEvents(photo, [event({ occurredAt: new Date(3000) })], CANDIDATES, from);
    expect(r.state["tel:+331"].option).toBeNull();
    expect(r.state["tel:+331"].lastAt).toBe(3000);
    expect(r.applied).toEqual([{ eventId: "e1", key: "tel:+331", option: null }]);
  });

  it("événement déjà reflété par votedAt ignoré mais intégré", () => {
    const r = applyVoteEvents(photo, [event({ selectedOptions: ["10H30"], occurredAt: new Date(1000) })], CANDIDATES, from);
    expect(r.state["tel:+331"].option).toBe("9H00");
    expect(r.integratedEventIds).toContain("e1");
    expect(r.applied).toEqual([]);
  });

  it("événement déjà intégré sauté", () => {
    const r = applyVoteEvents(photo, [event({})], CANDIDATES, { ...from, integratedEventIds: ["e1"] });
    expect(r.state["tel:+331"].option).toBe("9H00");
    expect(r.applied).toEqual([]);
  });

  it("faux retrait ignoré et signalé", () => {
    const fake = event({ selectedOptions: [], previousOptions: [] });
    const r = applyVoteEvents(photo, [fake], CANDIDATES, from);
    expect(r.suspiciousDeletions).toEqual([fake]);
    expect(r.state).toEqual(from.state);
  });

  it("@lid sans téléphone rapproché par nom", () => {
    const e = event({ actorPhone: null, actorName: "Stef", actorJid: "s@lid", selectedOptions: ["10H30"], previousOptions: ["9H00"] });
    const r = applyVoteEvents(photo, [e], CANDIDATES, from);
    expect(r.applied[0].key).toBe("tel:+332");
    expect(r.state["tel:+332"].option).toBe("10H30");
    expect(r.unmatchedNoPhone).toEqual([]);
  });

  it("@lid sans téléphone ni nom correspondant compté sous son JID", () => {
    const e = event({ actorPhone: null, actorName: "Inconnu", actorJid: "x@lid", selectedOptions: ["10H30"], previousOptions: [] });
    const r = applyVoteEvents(photo, [e], CANDIDATES, from);
    expect(r.applied[0].key).toBe("jid:x@lid");
    expect(r.state["jid:x@lid"]).toEqual({ option: "10H30", lastAt: 3000 });
    expect(r.unmatchedNoPhone).toEqual([e]);
  });

  it("option « Non » ne joue pas", () => {
    const r = applyVoteEvents(photo, [event({ selectedOptions: ["Non"] })], CANDIDATES, from);
    expect(r.state["tel:+331"].option).toBeNull();
  });

  it("événement hors poll_vote_* ignoré (CA-11)", () => {
    const r = applyVoteEvents(photo, [event({ eventType: "message_received", selectedOptions: ["10H30"] })], CANDIDATES, from);
    expect(r.state["tel:+331"].option).toBe("9H00");
    expect(r.applied).toEqual([]);
  });

  it("ne mute pas les entrées", () => {
    const snapshot = JSON.stringify(from);
    applyVoteEvents(photo, [event({})], CANDIDATES, from);
    expect(JSON.stringify(from)).toBe(snapshot);
  });

  it("applique dans l'ordre reçu : le dernier événement gagne", () => {
    const r = applyVoteEvents(
      photo,
      [
        event({ eventId: "a", selectedOptions: ["10H30"], occurredAt: new Date(3000) }),
        event({ eventId: "b", selectedOptions: ["9H00"], occurredAt: new Date(4000) }),
      ],
      CANDIDATES,
      from,
    );
    expect(r.state["tel:+331"]).toEqual({ option: "9H00", lastAt: 4000 });
    expect(r.integratedEventIds).toEqual(["a", "b"]);
  });
});

describe("toResolvedVotes", () => {
  it("répartit identifiés (heure / prête-nom) et inconnus", () => {
    const state = {
      "tel:+331": { option: "9H00", lastAt: 1 },
      "tel:+339": { option: "10H30", lastAt: 2 },
      "tel:+340": { option: SUBSTITUTE_VOLUNTEER_POLL_OPTION, lastAt: 3 },
      "tel:+341": { option: null, lastAt: 4 },
    };
    const identities = {
      "tel:+331": { userId: "u1", name: "Henry" },
      "tel:+339": { userId: null, name: "Inconnu" },
      "tel:+340": { userId: "u3", name: "Prêteur" },
    };
    const r = toResolvedVotes(state, identities, CANDIDATES);
    expect(r.confirmedPlayerIdsByTime["9H00"]).toContain("u1");
    expect(r.confirmedPlayerIdsByTime["10H30"]).toEqual([]);
    expect(r.volunteerSubstituteIds).toEqual(["u3"]);
    expect(r.unresolvedVoters).toEqual([{ name: "Inconnu", phone: "+339", option: "10H30" }]);
    expect(r.voterNames).toEqual({ u1: "Henry", u3: "Prêteur" });
  });

  it("clé jid: sans identité → phone null", () => {
    const r = toResolvedVotes({ "jid:x@lid": { option: "9H00", lastAt: 1 } }, { "jid:x@lid": { userId: null, name: "X" } }, CANDIDATES);
    expect(r.unresolvedVoters).toEqual([{ name: "X", phone: null, option: "9H00" }]);
  });
});
