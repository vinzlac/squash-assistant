import { describe, expect, it } from "vitest";
import type { VoteState } from "@squash-assistant/db/rosterTypes";
import { applyMoves, initialRosters, seatedKeys, type HourRoster } from "./allocation.js";

const CANDIDATES = ["9H00", "10H30"];
const name = (k: string) => k;
const v = (option: string | null, lastAt: number | null = 1) => ({ option, lastAt });
const hour = (rosters: HourRoster[], time: string) => rosters.find((r) => r.time === time)!;

describe("initialRosters", () => {
  it("trie par lastAt (null en dernier), puis téléphone, puis nom", () => {
    const state: VoteState = {
      "nom:Zoe": v("9H00", null),
      "tel:+33600000002": v("9H00", 5),
      "tel:+33600000001": v("9H00", 5),
      "nom:Abe": v("9H00", 5),
      "tel:+33600000009": v("9H00", 1),
    };
    const [r] = initialRosters([{ time: "9H00", capacity: 3 }], state, name);
    expect(seatedKeys(r)).toEqual(["tel:+33600000009", "tel:+33600000001", "tel:+33600000002"]);
    expect(r.waiting).toEqual(["nom:Abe", "nom:Zoe"]);
  });

  it("plafond 0 : aucun slot, tous en attente", () => {
    const [r] = initialRosters([{ time: "9H00", capacity: 0 }], { "nom:A": v("9H00") }, name);
    expect(r.slots).toEqual([]);
    expect(r.waiting).toEqual(["nom:A"]);
  });
});

const four = (): HourRoster[] =>
  initialRosters(
    [{ time: "9H00", capacity: 4 }, { time: "10H30", capacity: 1 }],
    { A: v("9H00", 1), B: v("9H00", 2), Henry: v("9H00", 3), D: v("9H00", 4), X: v("10H30", 5) },
    name,
  );

describe("applyMoves", () => {
  it("CA-4 : 5e oui à 09H00 sans désistement → attente, 4 inscrits", () => {
    const out = applyMoves(four(), [{ key: "Hugo2", option: "9H00" }], CANDIDATES);
    expect(seatedKeys(hour(out, "9H00"))).toHaveLength(4);
    expect(hour(out, "9H00").waiting).toEqual(["Hugo2"]);
  });

  it("CA-5 : Henry se retire, Hugo2 premier en attente → slot Hugo2 replaces Henry", () => {
    const out = applyMoves(four(), [{ key: "Hugo2", option: "9H00" }, { key: "Henry", option: null }], CANDIDATES);
    const slot = hour(out, "9H00").slots.find((s) => s.key === "Hugo2");
    expect(slot).toMatchObject({ key: "Hugo2", replaces: "Henry" });
    expect(hour(out, "9H00").waiting).toEqual([]);
  });

  it("CA-6 : place libre, deux votants successifs → le 1er inscrit (replaces Henry), le 2e en attente", () => {
    const out = applyMoves(
      four(),
      [{ key: "Henry", option: null }, { key: "N1", option: "9H00" }, { key: "N2", option: "9H00" }],
      CANDIDATES,
    );
    expect(hour(out, "9H00").slots.find((s) => s.key === "N1")).toMatchObject({ replaces: "Henry" });
    expect(hour(out, "9H00").waiting).toEqual(["N2"]);
  });

  it("CA-7 : place libre à 09H00, vote 10H30 complet → attente 10H30, slot 09H00 toujours libre", () => {
    const out = applyMoves(four(), [{ key: "Henry", option: null }, { key: "N1", option: "10H30" }], CANDIDATES);
    expect(hour(out, "10H30").waiting).toEqual(["N1"]);
    expect(hour(out, "9H00").slots.filter((s) => s.key === null)).toHaveLength(1);
  });

  it("CA-8 : désisté dont la place est reprise revote → fin d'attente", () => {
    const out = applyMoves(
      four(),
      [{ key: "Hugo2", option: "9H00" }, { key: "Henry", option: null }, { key: "Henry", option: "9H00" }],
      CANDIDATES,
    );
    expect(hour(out, "9H00").waiting).toEqual(["Henry"]);
  });

  it("R2-5 : il reprend sa propre place libérée, sans mention", () => {
    const out = applyMoves(four(), [{ key: "Henry", option: null }, { key: "Henry", option: "9H00" }], CANDIDATES);
    expect(hour(out, "9H00").slots.find((s) => s.key === "Henry")).toMatchObject({ replaces: null });
    expect(hour(out, "9H00").slots.every((s) => s.key !== null)).toBe(true);
  });

  it("R2-5 : deux places libérées (Henry puis Stef) → un nouveau prend celle d'Henry", () => {
    const start = initialRosters(
      [{ time: "9H00", capacity: 2 }],
      { Henry: v("9H00", 1), Stef: v("9H00", 2) },
      name,
    );
    const out = applyMoves(
      start,
      [{ key: "Henry", option: null }, { key: "Stef", option: null }, { key: "N", option: "9H00" }],
      ["9H00"],
    );
    expect(hour(out, "9H00").slots.find((s) => s.key === "N")).toMatchObject({ replaces: "Henry" });
    expect(hour(out, "9H00").slots.find((s) => s.key === null)).toMatchObject({ freedBy: "Stef" });
  });

  it("changement d'heure d'un inscrit : libère 09H00, attend à 10H30 si complet", () => {
    const out = applyMoves(four(), [{ key: "A", option: "10H30" }], CANDIDATES);
    expect(hour(out, "10H30").waiting).toEqual(["A"]);
    expect(hour(out, "9H00").slots.find((s) => s.key === null)).toMatchObject({ freedBy: "A" });
  });

  it("choix identique à l'état actuel : ne change rien", () => {
    const start = four();
    expect(applyMoves(start, [{ key: "A", option: "9H00" }], CANDIDATES)).toEqual(start);
  });

  it("option hors candidats (prête-nom) : vaut un retrait", () => {
    const out = applyMoves(four(), [{ key: "A", option: "Prête-nom" }], CANDIDATES);
    expect(seatedKeys(hour(out, "9H00"))).not.toContain("A");
  });

  it("vote pour une heure sans plafond : heure créée capacity 0, votant en attente", () => {
    const out = applyMoves(four(), [{ key: "N", option: "10H30" }], CANDIDATES);
    const created = applyMoves([], [{ key: "N", option: "10H30" }], CANDIDATES);
    expect(hour(created, "10H30")).toMatchObject({ capacity: 0, slots: [], waiting: ["N"] });
    expect(hour(out, "10H30").waiting).toEqual(["N"]);
  });

  it("pureté : rejouer applyMoves sur les mêmes entrées donne un résultat identique et n'altère pas l'entrée", () => {
    const start = four();
    const snapshot = structuredClone(start);
    const moves = [{ key: "Henry", option: null }, { key: "N", option: "9H00" }, { key: "A", option: "10H30" }];
    const first = applyMoves(start, moves, CANDIDATES);
    expect(applyMoves(start, moves, CANDIDATES)).toEqual(first);
    expect(start).toEqual(snapshot);
  });
});
