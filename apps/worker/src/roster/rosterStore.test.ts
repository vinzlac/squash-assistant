import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { jobRuns } from "@squash-assistant/db/schema";
import {
  claimRosterPublish,
  listJobsWithPinnedPoll,
  listJobsWithRoster,
  listJobsWithRosterOrphan,
  listPollVoteEventIds,
  listPollVoteEvents,
  mergeRosterIdentities,
  releaseRosterPublish,
  setRosterMessage,
} from "./rosterStore.js";

// Faux `db` : vrai query builder Drizzle (pg-proxy), le SQL généré et ses paramètres sont capturés,
// les lignes renvoyées sont des tableaux de valeurs « driver » dans l'ordre des champs sélectionnés.
interface Call { sql: string; params: unknown[] }
function fakeDb(rows: unknown[][] = []) {
  const calls: Call[] = [];
  const db = drizzle(async (sql, params) => {
    calls.push({ sql, params });
    return { rows };
  });
  return { db: db as never, calls };
}

const JOB_COLUMNS = Object.keys(getTableColumns(jobRuns));
/** Ligne `job_runs` au format driver (timestamps en texte, comme postgres-js via Drizzle). */
function jobRow(overrides: Record<string, unknown> = {}, extra: unknown[] = []): unknown[] {
  const base: Record<string, unknown> = {
    id: "job-1",
    bookingRuleId: "rule-1",
    targetDate: "2026-11-01",
    auto: false,
    createdAt: "2026-10-24 10:00:00",
    ...overrides,
  };
  return [...JOB_COLUMNS.map((k) => base[k] ?? null), ...extra];
}

const NOW = new Date("2026-10-25T12:00:00.000Z");

describe("listPollVoteEvents", () => {
  it("mappe payload.data vers VoteEventRow", async () => {
    const payload = {
      eventId: "ev-1",
      data: { pollWhatsappMessageId: "poll-1", pollName: "Q", selectedOptions: ["18H45"], previousOptions: ["Non"] },
    };
    const { db } = fakeDb([
      ["ev-1", "poll_vote_update", "2026-10-25 08:00:01", "2026-10-25 08:00:00+00", "+33611", "336@s.whatsapp.net", "Bob", JSON.stringify(payload)],
    ]);

    const rows = await listPollVoteEvents(db, { chatJid: "grp@g.us", pollMsgId: "poll-1" });

    expect(rows).toEqual([
      {
        eventId: "ev-1",
        eventType: "poll_vote_update",
        createdAt: new Date("2026-10-25T08:00:01.000Z"),
        occurredAt: new Date("2026-10-25T08:00:00.000Z"),
        actorPhone: "+33611",
        actorJid: "336@s.whatsapp.net",
        actorName: "Bob",
        selectedOptions: ["18H45"],
        previousOptions: ["Non"],
      },
    ]);
    expect(rows[0].createdAt).toBeInstanceOf(Date);
    expect(rows[0].occurredAt).toBeInstanceOf(Date);
  });

  it("listes absentes du payload → tableaux vides", async () => {
    const { db } = fakeDb([["ev-2", "poll_vote_deletion", "2026-10-25 08:00:01", "2026-10-25 08:00:00+00", null, "jid", null, { data: {} }]]);
    const [row] = await listPollVoteEvents(db, { chatJid: "grp@g.us", pollMsgId: "poll-1" });
    expect(row.selectedOptions).toEqual([]);
    expect(row.previousOptions).toEqual([]);
  });

  it("ne retient que les poll_vote_* du sondage et du groupe (CA-11), triés created_at puis event_id", async () => {
    const { db, calls } = fakeDb([]);

    await listPollVoteEvents(db, { chatJid: "grp@g.us", pollMsgId: "poll-1" });

    const [{ sql, params }] = calls;
    expect(sql).toContain('"whatsapp_resa_events"."event_type" in ($1, $2, $3)');
    expect(params.slice(0, 3)).toEqual(["poll_vote_creation", "poll_vote_update", "poll_vote_deletion"]);
    expect(sql).toContain('"whatsapp_resa_events"."chat_jid" = $4');
    expect(sql).toContain(`"whatsapp_resa_events"."payload"->'data'->>'pollWhatsappMessageId' = $5`);
    expect(params.slice(3)).toEqual(["grp@g.us", "poll-1"]);
    expect(sql).toMatch(/order by "whatsapp_resa_events"\."created_at" asc, "whatsapp_resa_events"\."event_id" asc$/);
  });

  it("listPollVoteEventIds applique les mêmes conditions et renvoie les ids", async () => {
    const { db, calls } = fakeDb([["ev-1"], ["ev-2"]]);

    const ids = await listPollVoteEventIds(db, { chatJid: "grp@g.us", pollMsgId: "poll-1" });

    expect(ids).toEqual(["ev-1", "ev-2"]);
    expect(calls[0].params).toEqual(["poll_vote_creation", "poll_vote_update", "poll_vote_deletion", "grp@g.us", "poll-1"]);
    expect(calls[0].sql).toContain("order by");
  });
});

describe("setRosterMessage", () => {
  it("setRosterMessage(null) remet msgId, jid, fingerprint et roster_pinned_at à null", async () => {
    const { db, calls } = fakeDb();

    await setRosterMessage(db, "job-1", null);

    const [{ sql, params }] = calls;
    expect(sql).toBe(
      'update "job_runs" set "roster_msg_id" = $1, "roster_jid" = $2, "roster_sent_at" = $3, "roster_fingerprint" = $4, "roster_pinned_at" = $5 where "job_runs"."id" = $6',
    );
    expect(params).toEqual([null, null, null, null, null, "job-1"]);
  });

  it("un nouveau message remet aussi roster_pinned_at à null", async () => {
    const { db, calls } = fakeDb();

    await setRosterMessage(db, "job-1", { msgId: "m1", jid: "grp@g.us", sentAt: NOW, fingerprint: "fp" });

    expect(calls[0].params).toEqual(["m1", "grp@g.us", NOW.toISOString(), "fp", null, "job-1"]);
  });
});

describe("claimRosterPublish", () => {
  it("renvoie la ligne fraîche, reclaimedStale faux si aucun claim précédent", async () => {
    const { db, calls } = fakeDb([jobRow({ rosterClaimedAt: "2026-10-25 12:00:00", rosterMsgId: "m0" }, [null])]);

    const res = await claimRosterPublish(db, "job-1", NOW);

    expect(res?.reclaimedStale).toBe(false);
    expect(res?.job.id).toBe("job-1");
    expect(res?.job.rosterMsgId).toBe("m0");
    expect(res?.job.rosterClaimedAt).toEqual(NOW);
    const [{ sql, params }] = calls;
    expect(sql).toMatch(/^with "prev" as \(select "roster_claimed_at" from "job_runs" where "job_runs"\."id" = \$1\) update "job_runs" set "roster_claimed_at" = \$2/);
    expect(sql).toContain('("job_runs"."roster_claimed_at" is null or "job_runs"."roster_claimed_at" < $4)');
    expect(sql).toContain("(select roster_claimed_at from prev)");
    expect(params).toEqual(["job-1", NOW.toISOString(), "job-1", new Date(NOW.getTime() - 120_000).toISOString()]);
  });

  it("null si un claim récent existe (aucune ligne mise à jour)", async () => {
    const { db } = fakeDb([]);
    expect(await claimRosterPublish(db, "job-1", NOW)).toBeNull();
  });

  it("reclaimedStale vrai si un claim périmé est repris", async () => {
    const { db, calls } = fakeDb([jobRow({ rosterClaimedAt: "2026-10-25 12:00:00" }, ["2026-10-25 11:50:00"])]);

    const res = await claimRosterPublish(db, "job-1", NOW, 60_000);

    expect(res?.reclaimedStale).toBe(true);
    expect(calls[0].params[3]).toBe(new Date(NOW.getTime() - 60_000).toISOString());
  });
});

describe("releaseRosterPublish", () => {
  it("ne libère que son propre claim", async () => {
    const { db, calls } = fakeDb();

    await releaseRosterPublish(db, "job-1", NOW);

    const [{ sql, params }] = calls;
    expect(sql).toBe(
      'update "job_runs" set "roster_claimed_at" = $1 where ("job_runs"."id" = $2 and "job_runs"."roster_claimed_at" = $3)',
    );
    expect(params).toEqual([null, "job-1", NOW.toISOString()]);
  });
});

describe("mergeRosterIdentities", () => {
  const patch = { "tel:+33611": { userId: "u1", name: "Bob" } };

  it('en "keep" la valeur en base l\'emporte : patch || base', async () => {
    const { db, calls } = fakeDb();

    await mergeRosterIdentities(db, "job-1", patch, "keep");

    const [{ sql, params }] = calls;
    expect(sql).toBe(
      `update "job_runs" set "roster_identities" = $1::jsonb || coalesce("job_runs"."roster_identities", '{}'::jsonb) where "job_runs"."id" = $2`,
    );
    expect(params).toEqual([JSON.stringify(patch), "job-1"]);
  });

  it('en "override" le patch l\'emporte : base || patch', async () => {
    const { db, calls } = fakeDb();

    await mergeRosterIdentities(db, "job-1", patch, "override");

    expect(calls[0].sql).toBe(
      `update "job_runs" set "roster_identities" = coalesce("job_runs"."roster_identities", '{}'::jsonb) || $1::jsonb where "job_runs"."id" = $2`,
    );
  });
});

describe("listes de jobs du tick", () => {
  it("listJobsWithRoster : photo présente, ni arrêté ni annulé, date cible >= fromDate", async () => {
    const { db, calls } = fakeDb([jobRow()]);

    const jobs = await listJobsWithRoster(db, "2026-10-25");

    expect(jobs.map((j) => j.id)).toEqual(["job-1"]);
    expect(calls[0].sql).toContain(
      'where ("job_runs"."roster_photo" is not null and "job_runs"."roster_stopped_at" is null and "job_runs"."cancelled_at" is null and "job_runs"."target_date" >= $1)',
    );
    expect(calls[0].params).toEqual(["2026-10-25"]);
  });

  it("listJobsWithRosterOrphan : orphelin présent, sans autre filtre", async () => {
    const { db, calls } = fakeDb([]);
    await listJobsWithRosterOrphan(db);
    expect(calls[0].sql).toMatch(/where "job_runs"\."roster_orphan" is not null$/);
  });

  it("listJobsWithPinnedPoll : mode roster, sondage connu et pas encore désépinglé", async () => {
    const { db, calls } = fakeDb([]);
    await listJobsWithPinnedPoll(db);
    expect(calls[0].sql).toMatch(
      /where \("job_runs"\."roster_photo" is not null and "job_runs"\."poll_msg_id" is not null and "job_runs"\."poll_unpinned_at" is null\)$/,
    );
    expect(calls[0].params).toEqual([]);
  });
});
