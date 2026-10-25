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
    expect(normalizePhone("+33 6 12-34")).toBe("+3361234");
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
  it("téléphone inconnu de la photo : rapproché par nom d'un votant sans téléphone (B1-2)", () => {
    const withLea: VotePhoto = {
      ...photo,
      voters: [...photo.voters, { key: "nom:Léa", phone: null, waName: "Léa", option: "9H00", votedAt: 1500 }],
    };
    expect(eventVoterKey(event({ actorPhone: "+339", actorName: " Léa " }), withLea)).toEqual({ key: "nom:Léa", matchedBy: "name" });
    // Le téléphone d'un votant de la photo reste prioritaire, même homonyme.
    expect(eventVoterKey(event({ actorPhone: "+331", actorName: "Léa" }), withLea)).toEqual({ key: "tel:+331", matchedBy: "phone" });
    // Homonyme avec téléphone dans la photo : pas de rapprochement par nom.
    expect(eventVoterKey(event({ actorPhone: "+339", actorName: "Henry" }), withLea)).toEqual({ key: "tel:+339", matchedBy: "phone" });
  });
  it("retrait de Léa (photo nom:, événement avec téléphone) : plus inscrite, pas de doublon (B1-2)", () => {
    const withLea: VotePhoto = {
      ...photo,
      voters: [...photo.voters, { key: "nom:Léa", phone: null, waName: "Léa", option: "9H00", votedAt: 1500 }],
    };
    const r = applyVoteEvents(
      withLea,
      [event({ actorPhone: "+339", actorJid: "339@s.whatsapp.net", actorName: "Léa" })],
      CANDIDATES,
      { state: photoState(withLea, CANDIDATES), integratedEventIds: [] },
    );
    expect(r.state["nom:Léa"].option).toBeNull();
    expect(r.state["tel:+339"]).toBeUndefined();
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

  it("retrait vide d'un votant qui avait une heure : désistement appliqué et signalé", () => {
    const empty = event({ selectedOptions: [], previousOptions: [] });
    const r = applyVoteEvents(photo, [empty], CANDIDATES, from);
    expect(r.state["tel:+331"].option).toBeNull();
    expect(r.applied).toEqual([{ eventId: "e1", key: "tel:+331", option: null }]);
    expect(r.emptyRetractions).toEqual([{ event: empty, previousOption: "9H00" }]);
  });

  it("retrait vide puis revote au même instant : le revote s'applique", () => {
    const empty = event({ eventId: "e1", selectedOptions: [], previousOptions: [] });
    const revote = event({ eventId: "e2", selectedOptions: ["10H30"], previousOptions: [] });
    const r = applyVoteEvents(photo, [empty, revote], CANDIDATES, from);
    expect(r.state["tel:+331"]).toEqual({ option: "10H30", lastAt: 3000 });
  });

  it("retrait vide sans téléphone rapproché par nom : désistement appliqué", () => {
    const empty = event({ actorPhone: null, actorName: "Stef", actorJid: "s@lid", selectedOptions: [], previousOptions: [] });
    const r = applyVoteEvents(photo, [empty], CANDIDATES, from);
    expect(r.state["tel:+332"].option).toBeNull();
    expect(r.emptyRetractions).toEqual([{ event: empty, previousOption: "9H00" }]);
  });

  it("retrait vide d'un votant @lid non rapproché : état inchangé mais signalé", () => {
    const empty = event({ actorPhone: null, actorName: "Inconnu", actorJid: "x@lid", selectedOptions: [], previousOptions: [] });
    const r = applyVoteEvents(photo, [empty], CANDIDATES, from);
    expect(r.state).toEqual(from.state);
    expect(r.applied).toEqual([]);
    expect(r.emptyRetractions).toEqual([{ event: empty, previousOption: null }]);
    expect(r.unmatchedNoPhone).toEqual([]);
  });

  it("retrait vide d'une clé jid: déjà votante : un seul signalement", () => {
    const vote = event({ eventId: "e1", actorPhone: null, actorName: "Inconnu", actorJid: "x@lid", selectedOptions: ["10H30"], previousOptions: [] });
    const empty = event({ eventId: "e2", occurredAt: new Date(3500), actorPhone: null, actorName: "Inconnu", actorJid: "x@lid", selectedOptions: [], previousOptions: [] });
    const r = applyVoteEvents(photo, [vote, empty], CANDIDATES, from);
    expect(r.state["jid:x@lid"].option).toBeNull();
    expect(r.emptyRetractions).toEqual([{ event: empty, previousOption: "10H30" }]);
    expect(r.unmatchedNoPhone).toEqual([vote]);
  });

  it("retrait vide d'un votant sans vote précédent : ignoré sans signalement", () => {
    const empty = event({ actorPhone: "+339", actorJid: "339@s.whatsapp.net", actorName: "Nouveau", selectedOptions: [], previousOptions: [] });
    const r = applyVoteEvents(photo, [empty], CANDIDATES, from);
    expect(r.state).toEqual(from.state);
    expect(r.applied).toEqual([]);
    expect(r.emptyRetractions).toEqual([]);
    expect(r.integratedEventIds).toContain("e1");
  });

  it("retrait vide périmé : ignoré sans signalement", () => {
    const empty = event({ occurredAt: new Date(1000), selectedOptions: [], previousOptions: [] });
    const r = applyVoteEvents(photo, [empty], CANDIDATES, from);
    expect(r.state).toEqual(from.state);
    expect(r.emptyRetractions).toEqual([]);
  });

  it("retrait vide suivi d'un « Non » : le vote suivant donne l'état final", () => {
    const empty = event({ eventId: "e1", selectedOptions: [], previousOptions: [] });
    const non = event({ eventId: "e2", occurredAt: new Date(3001), selectedOptions: ["Non"], previousOptions: [] });
    const r = applyVoteEvents(photo, [empty, non], CANDIDATES, from);
    expect(r.state["tel:+331"]).toEqual({ option: null, lastAt: 3001 });
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
    const events = [event({})];
    const snapshot = JSON.stringify({ from, photo, events });
    applyVoteEvents(photo, events, CANDIDATES, from);
    expect(JSON.stringify({ from, photo, events })).toBe(snapshot);
  });

  it("événement suspect intégré", () => {
    const r = applyVoteEvents(photo, [event({ eventId: "s", selectedOptions: [], previousOptions: [] })], CANDIDATES, from);
    expect(r.integratedEventIds).toContain("s");
  });

  it("événement jid: périmé absent de unmatchedNoPhone", () => {
    const first = event({ eventId: "a", actorPhone: null, actorName: null, actorJid: "x@lid", selectedOptions: ["9H00"], occurredAt: new Date(3000) });
    const stale = event({ eventId: "b", actorPhone: null, actorName: null, actorJid: "x@lid", selectedOptions: ["10H30"], occurredAt: new Date(2500) });
    const r = applyVoteEvents(photo, [first, stale], CANDIDATES, from);
    expect(r.unmatchedNoPhone).toEqual([first]);
    expect(r.state["jid:x@lid"].option).toBe("9H00");
  });

  it("événement périmé rapproché par nom ignoré", () => {
    const e = event({ actorPhone: null, actorName: "Stef", selectedOptions: ["10H30"], occurredAt: new Date(2000) });
    const r = applyVoteEvents(photo, [e], CANDIDATES, from);
    expect(r.state["tel:+332"].option).toBe("9H00");
    expect(r.integratedEventIds).toContain("e1");
  });

  it("votant de la photo avec votedAt null : tout événement s'applique", () => {
    const p: VotePhoto = { ...photo, voters: [{ key: "tel:+5", phone: "+5", waName: "Z", option: "9H00", votedAt: null }] };
    const e = event({ actorPhone: "+5", occurredAt: new Date(1), selectedOptions: ["10H30"] });
    const r = applyVoteEvents(p, [e], CANDIDATES, { state: photoState(p, CANDIDATES), integratedEventIds: [] });
    expect(r.state["tel:+5"]).toEqual({ option: "10H30", lastAt: 1 });
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

  it("option non nulle sans identité → unresolvedVoters", () => {
    const r = toResolvedVotes({ "tel:+7": { option: "9H00", lastAt: 1 }, "jid:y@lid": { option: "10H30", lastAt: 1 } }, {}, CANDIDATES);
    expect(r.unresolvedVoters).toEqual([
      { name: "", phone: "+7", option: "9H00" },
      { name: "", phone: null, option: "10H30" },
    ]);
  });

  it("clé jid: sans identité → phone null", () => {
    const r = toResolvedVotes({ "jid:x@lid": { option: "9H00", lastAt: 1 } }, { "jid:x@lid": { userId: null, name: "X" } }, CANDIDATES);
    expect(r.unresolvedVoters).toEqual([{ name: "X", phone: null, option: "9H00" }]);
  });
});
