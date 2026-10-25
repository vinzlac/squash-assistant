// Types du roster vivant (spec 2026-10-24-roster-desistements) — fichier de types seulement,
// partagé entre le schéma (colonnes jsonb de `job_runs`) et le worker.

export type VoterKey = string; // "tel:+33…" | "jid:…" | "nom:…"
export interface PhotoVoter { key: VoterKey; phone: string | null; waName: string; option: string; votedAt: number | null }
export interface VotePhoto { capturedAt: string; integratedEventIds: string[]; voters: PhotoVoter[] }
export interface VoterIdentity { userId: string | null; name: string }
export type Identities = Record<VoterKey, VoterIdentity>;
export interface VoterVote { option: string | null; lastAt: number | null } // option null = ne joue pas
export type VoteState = Record<VoterKey, VoterVote>;
export interface RosterPlanSnapshot { tPlan: string; state: VoteState; integratedEventIds: string[] }
export interface HourCapacity { time: string; capacity: number }
export interface RosterFinal {
  base: RosterPlanSnapshot; hours: HourCapacity[]; realBooking: boolean;
  title: string; courtsBlock: string; failuresNote: string; capacityNote: string;
}
export interface RosterOrphan { msgId: string; jid: string; expiresAt: string }
/** Événement de vote lu dans `whatsapp_resa_events` (payload.data), dans l'ordre `created_at` puis `event_id`. */
export interface VoteEventRow { eventId: string; eventType: string; createdAt: Date; occurredAt: Date; actorPhone: string | null; actorJid: string; actorName: string | null; selectedOptions: string[]; previousOptions: string[] }
