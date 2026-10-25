import { and, asc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "@squash-assistant/db/client";
import { jobRuns, whatsappResaEvents, type JobRun } from "@squash-assistant/db/schema";
import type {
  Identities,
  RosterFinal,
  RosterOrphan,
  RosterPlanSnapshot,
  VoteEventRow,
  VotePhoto,
} from "@squash-assistant/db/rosterTypes";

// Accès en base du roster vivant (spec 2026-10-24-roster-desistements) : événements de vote
// persistés par le listener, colonnes `roster_*` de `job_runs`. L'appelant passe toujours ses
// dates (`new Date()` côté JS, jamais `now()` SQL), comme dans `jobRuns.ts`.

const POLL_VOTE_EVENT_TYPES = ["poll_vote_creation", "poll_vote_update", "poll_vote_deletion"] as const;
/** Claim de publication considéré comme abandonné (pod tué en cours d'envoi) au-delà de ce délai. */
const ROSTER_CLAIM_STALE_MS = 120_000;

interface PollRef { chatJid: string; pollMsgId: string }

/** Votes du sondage `pollMsgId` dans le groupe `chatJid` — les autres sondages/groupes sont ignorés (CA-11). */
function pollVoteEventsWhere({ chatJid, pollMsgId }: PollRef) {
  return and(
    inArray(whatsappResaEvents.eventType, [...POLL_VOTE_EVENT_TYPES]),
    eq(whatsappResaEvents.chatJid, chatJid),
    sql`${whatsappResaEvents.payload}->'data'->>'pollWhatsappMessageId' = ${pollMsgId}`,
  );
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function pollVoteData(payload: unknown): Record<string, unknown> {
  const data = (payload as { data?: unknown } | null)?.data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

/** Événements de vote dans l'ordre d'application : `created_at` puis `event_id`. */
export async function listPollVoteEvents(db: Database, ref: PollRef): Promise<VoteEventRow[]> {
  const rows = await db
    .select({
      eventId: whatsappResaEvents.eventId,
      eventType: whatsappResaEvents.eventType,
      createdAt: whatsappResaEvents.createdAt,
      occurredAt: whatsappResaEvents.occurredAt,
      actorPhone: whatsappResaEvents.actorPhone,
      actorJid: whatsappResaEvents.actorJid,
      actorName: whatsappResaEvents.actorName,
      payload: whatsappResaEvents.payload,
    })
    .from(whatsappResaEvents)
    .where(pollVoteEventsWhere(ref))
    .orderBy(asc(whatsappResaEvents.createdAt), asc(whatsappResaEvents.eventId));
  return rows.map(({ payload, ...row }) => {
    const data = pollVoteData(payload);
    return { ...row, selectedOptions: stringList(data.selectedOptions), previousOptions: stringList(data.previousOptions) };
  });
}

export async function listPollVoteEventIds(db: Database, ref: PollRef): Promise<string[]> {
  const rows = await db
    .select({ eventId: whatsappResaEvents.eventId })
    .from(whatsappResaEvents)
    .where(pollVoteEventsWhere(ref))
    .orderBy(asc(whatsappResaEvents.createdAt), asc(whatsappResaEvents.eventId));
  return rows.map((r) => r.eventId);
}

export async function saveRosterPhoto(db: Database, jobId: string, photo: VotePhoto, identities: Identities): Promise<void> {
  await db.update(jobRuns).set({ rosterPhoto: photo, rosterIdentities: identities }).where(eq(jobRuns.id, jobId));
}

/**
 * Fusion atomique des identités (une seule requête, pas de lecture-écriture). `||` jsonb : à
 * clé égale, l'opérande de droite gagne. `override` (« Recalculer ») : le patch gagne ; `keep`
 * (recherche d'un votant nouveau) : la base gagne, une recherche ratée n'écrase jamais une identification.
 */
export async function mergeRosterIdentities(
  db: Database,
  jobId: string,
  patch: Identities,
  mode: "override" | "keep",
): Promise<void> {
  const current = sql`coalesce(${jobRuns.rosterIdentities}, '{}'::jsonb)`;
  const incoming = sql`${JSON.stringify(patch)}::jsonb`;
  const merged = mode === "override" ? sql`${current} || ${incoming}` : sql`${incoming} || ${current}`;
  await db.update(jobRuns).set({ rosterIdentities: merged }).where(eq(jobRuns.id, jobId));
}

export async function saveRosterPlanSnapshot(db: Database, jobId: string, snapshot: RosterPlanSnapshot): Promise<void> {
  await db.update(jobRuns).set({ rosterPlanSnapshot: snapshot }).where(eq(jobRuns.id, jobId));
}

export async function saveRosterFinal(db: Database, jobId: string, final: RosterFinal): Promise<void> {
  await db.update(jobRuns).set({ rosterFinal: final }).where(eq(jobRuns.id, jobId));
}

/**
 * Réserve la publication du roster (même idée que `claimStartReminder`) : renvoie la ligne
 * fraîche, ou null si un claim récent existe. Un claim plus vieux que `staleMs` est repris
 * (`reclaimedStale`) — la CTE `prev` lit l'ancienne valeur dans la même requête.
 */
export async function claimRosterPublish(
  db: Database,
  jobId: string,
  now: Date,
  staleMs = ROSTER_CLAIM_STALE_MS,
): Promise<{ job: JobRun; reclaimedStale: boolean } | null> {
  const prev = db
    .$with("prev")
    .as(db.select({ rosterClaimedAt: jobRuns.rosterClaimedAt }).from(jobRuns).where(eq(jobRuns.id, jobId)));
  const [row] = await db
    .with(prev)
    .update(jobRuns)
    .set({ rosterClaimedAt: now })
    .where(
      and(
        eq(jobRuns.id, jobId),
        or(isNull(jobRuns.rosterClaimedAt), lt(jobRuns.rosterClaimedAt, new Date(now.getTime() - staleMs))),
      ),
    )
    .returning({ ...getTableColumns(jobRuns), prevClaimedAt: sql<string | null>`(select roster_claimed_at from prev)` });
  if (!row) return null;
  const { prevClaimedAt, ...job } = row;
  return { job, reclaimedStale: prevClaimedAt != null };
}

/** Libère le claim seulement s'il vaut encore `claimedAt` — un claim repris par un autre reste en place. */
export async function releaseRosterPublish(db: Database, jobId: string, claimedAt: Date): Promise<void> {
  await db
    .update(jobRuns)
    .set({ rosterClaimedAt: null })
    .where(and(eq(jobRuns.id, jobId), eq(jobRuns.rosterClaimedAt, claimedAt)));
}

/** Nouveau roster publié (ou `null` : plus de roster courant). Le nouveau message n'est jamais encore épinglé. */
export async function setRosterMessage(
  db: Database,
  jobId: string,
  msg: { msgId: string; jid: string; sentAt: Date; fingerprint: string } | null,
): Promise<void> {
  await db
    .update(jobRuns)
    .set({
      rosterMsgId: msg?.msgId ?? null,
      rosterJid: msg?.jid ?? null,
      rosterSentAt: msg?.sentAt ?? null,
      rosterFingerprint: msg?.fingerprint ?? null,
      rosterPinnedAt: null,
    })
    .where(eq(jobRuns.id, jobId));
}

/** Envoi réussi sans `msgId` : on garde l'empreinte pour ne pas reposter le même contenu. */
export async function setRosterFingerprint(db: Database, jobId: string, fingerprint: string): Promise<void> {
  await db.update(jobRuns).set({ rosterFingerprint: fingerprint }).where(eq(jobRuns.id, jobId));
}

export async function setRosterPinnedAt(db: Database, jobId: string, at: Date | null): Promise<void> {
  await db.update(jobRuns).set({ rosterPinnedAt: at }).where(eq(jobRuns.id, jobId));
}

export async function setRosterOrphan(db: Database, jobId: string, orphan: RosterOrphan | null): Promise<void> {
  await db.update(jobRuns).set({ rosterOrphan: orphan }).where(eq(jobRuns.id, jobId));
}

export async function setRosterStoppedAt(db: Database, jobId: string, at: Date): Promise<void> {
  await db.update(jobRuns).set({ rosterStoppedAt: at }).where(eq(jobRuns.id, jobId));
}

export async function setPollUnpinnedAt(db: Database, jobId: string, at: Date): Promise<void> {
  await db.update(jobRuns).set({ pollUnpinnedAt: at }).where(eq(jobRuns.id, jobId));
}

/** Rosters vivants à examiner par le tick : mode roster, ni arrêté ni annulé, match à venir. */
export async function listJobsWithRoster(db: Database, fromDate: string): Promise<JobRun[]> {
  return db
    .select()
    .from(jobRuns)
    .where(
      and(
        isNotNull(jobRuns.rosterPhoto),
        isNull(jobRuns.rosterStoppedAt),
        isNull(jobRuns.cancelledAt),
        gte(jobRuns.targetDate, fromDate),
      ),
    );
}

/** Anciens rosters restant à nettoyer — aucun autre filtre : un orphelin doit toujours finir traité. */
export async function listJobsWithRosterOrphan(db: Database): Promise<JobRun[]> {
  return db.select().from(jobRuns).where(isNotNull(jobRuns.rosterOrphan));
}

/** Sondages conservés encore épinglés — sans filtre de date ni d'état : ils doivent toujours finir désépinglés. */
export async function listJobsWithPinnedPoll(db: Database): Promise<JobRun[]> {
  return db
    .select()
    .from(jobRuns)
    .where(and(isNotNull(jobRuns.rosterPhoto), isNotNull(jobRuns.pollMsgId), isNull(jobRuns.pollUnpinnedAt)));
}
