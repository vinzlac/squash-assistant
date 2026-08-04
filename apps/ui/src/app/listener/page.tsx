import Link from "next/link";
import { isAdmin } from "../../lib/authz";
import { formatDateTimeParis } from "../../lib/datetime";
import {
  countResaEvents,
  getRelaySettings,
  listResaEvents,
  type ListResaEventsFilter,
  type ResaEventsSort,
} from "../../lib/listenerAdmin";
import { updateListenerRelaySettingsAction } from "../actions";
import { SubmitButton } from "../components/SubmitButton";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

const EVENT_TYPE_LABELS: Record<string, string> = {
  poll_creation: "Création de sondage",
  poll_vote_creation: "Nouveau vote",
  poll_vote_update: "Modification de vote",
  poll_vote_deletion: "Suppression de vote",
};

const RELAY_FILTERS: Array<{
  name: string;
  field: "pollCreation" | "pollVoteCreation" | "pollVoteUpdate" | "pollVoteDeletion";
  label: string;
}> = [
  { name: "poll_creation", field: "pollCreation", label: "Création de sondage (poll_creation)" },
  { name: "poll_vote_creation", field: "pollVoteCreation", label: "Nouveau vote (poll_vote_creation)" },
  { name: "poll_vote_update", field: "pollVoteUpdate", label: "Modification de vote (poll_vote_update)" },
  { name: "poll_vote_deletion", field: "pollVoteDeletion", label: "Suppression de vote (poll_vote_deletion)" },
];

function actorLabel(actorName: string | null, actorPhone: string | null): string {
  if (actorName && actorPhone) return `${actorName} (${actorPhone})`;
  return actorName ?? actorPhone ?? "—";
}

function groupLabel(chatName: string | null, chatJid: string): string {
  return chatName ?? chatJid;
}

function parseSort(raw: string | undefined): ResaEventsSort {
  return raw === "asc" ? "asc" : "desc";
}

function buildQuery(params: Record<string, string | undefined>, overrides: Record<string, string | undefined> = {}) {
  const merged = { ...params, ...overrides };
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined && value !== "") sp.set(key, value);
  }
  const q = sp.toString();
  return q ? `/listener?${q}` : "/listener";
}

export default async function ListenerPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    sort?: string;
    type?: string;
    group?: string;
    actor?: string;
    summary?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const admin = await isAdmin();
  if (!admin) {
    return (
      <main>
        <p>
          <Link href="/">← Retour</Link>
        </p>
        <h1>Listener WhatsApp</h1>
        <p className="muted">
          Accès réservé aux administrateurs (groupe Authentik &quot;squash-admins&quot;).
        </p>
      </main>
    );
  }

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const sort = parseSort(sp.sort);
  const filter: ListResaEventsFilter = {
    eventType: sp.type || undefined,
    group: sp.group || undefined,
    actor: sp.actor || undefined,
    summary: sp.summary || undefined,
    occurredFrom: sp.from || undefined,
    occurredTo: sp.to || undefined,
  };
  const offset = (page - 1) * PAGE_SIZE;

  const queryBase: Record<string, string | undefined> = {
    sort: sort === "asc" ? "asc" : undefined,
    type: sp.type,
    group: sp.group,
    actor: sp.actor,
    summary: sp.summary,
    from: sp.from,
    to: sp.to,
  };

  const [settings, events, total] = await Promise.all([
    getRelaySettings(),
    listResaEvents({ ...filter, limit: PAGE_SIZE, offset, sort }),
    countResaEvents(filter),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromIdx = total === 0 ? 0 : offset + 1;
  const toIdx = Math.min(offset + events.length, total);

  return (
    <main style={{ maxWidth: 1100 }}>
      <p>
        <Link href="/">← Retour</Link>
      </p>
      <h1>Listener WhatsApp</h1>
      <p className="muted">
        Historique des événements résa WhatsApp et filtres du relais vers Vincent All. Le rafraîchissement live
        de l&apos;UI n&apos;est pas affecté par ces filtres.
      </p>

      <h2>Filtres relais WhatsApp</h2>
      <p className="muted">
        Types d&apos;événements relayés vers le groupe Vincent All. Décocher un type désactive le message WhatsApp
        pour ce type uniquement.
      </p>
      <form action={updateListenerRelaySettingsAction}>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          {RELAY_FILTERS.map(({ name, field, label }) => (
            <label key={name} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.35rem 0" }}>
              <input type="checkbox" name={name} defaultChecked={settings[field]} />
              {label}
            </label>
          ))}
          <div className="form-actions">
            <SubmitButton className="button-primary">Enregistrer</SubmitButton>
          </div>
        </fieldset>
      </form>

      <h2>Historique</h2>
      <p className="muted">
        {total === 0
          ? "Aucun événement."
          : `${fromIdx}–${toIdx} sur ${total} — page ${page}/${totalPages} (${PAGE_SIZE} par page).`}
      </p>

      <form method="get" action="/listener" className="listener-filters" style={{ marginTop: "0.75rem" }}>
        <input type="hidden" name="sort" value={sort} />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: "0.75rem",
            alignItems: "end",
          }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
            Du
            <input type="date" name="from" defaultValue={sp.from ?? ""} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
            Au
            <input type="date" name="to" defaultValue={sp.to ?? ""} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
            Type
            <select name="type" defaultValue={sp.type ?? ""}>
              <option value="">Tous</option>
              {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
            Groupe
            <input type="search" name="group" defaultValue={sp.group ?? ""} placeholder="Nom ou JID" />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
            Acteur
            <input type="search" name="actor" defaultValue={sp.actor ?? ""} placeholder="Nom ou téléphone" />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
            Résumé
            <input type="search" name="summary" defaultValue={sp.summary ?? ""} placeholder="Texte…" />
          </label>
        </div>
        <div className="form-actions" style={{ marginTop: "0.75rem", display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <button type="submit" className="button-primary">
            Filtrer
          </button>
          <Link href="/listener" className="muted">
            Réinitialiser
          </Link>
        </div>
      </form>

      <div className="table-scroll" style={{ marginTop: "1rem" }}>
        <table>
          <thead>
            <tr>
              <th>
                <Link
                  href={buildQuery(queryBase, {
                    sort: sort === "desc" ? "asc" : undefined,
                    page: undefined,
                  })}
                  title={sort === "desc" ? "Passer en plus anciens d'abord" : "Passer en plus récents d'abord"}
                >
                  Date {sort === "desc" ? "↓" : "↑"}
                </Link>
              </th>
              <th>Type</th>
              <th>Groupe</th>
              <th>Acteur</th>
              <th>Résumé</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="muted">{formatDateTimeParis(event.occurredAt)}</td>
                <td>{EVENT_TYPE_LABELS[event.eventType] ?? event.eventType}</td>
                <td>{groupLabel(event.chatName, event.chatJid)}</td>
                <td>{actorLabel(event.actorName, event.actorPhone)}</td>
                <td style={{ whiteSpace: "pre-wrap", fontSize: "0.9rem" }}>{event.summary}</td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Aucun événement pour ces filtres.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <nav style={{ display: "flex", gap: "1rem", marginTop: "1rem", flexWrap: "wrap", alignItems: "center" }}>
        {page > 1 && (
          <Link href={buildQuery(queryBase, { page: page === 2 ? undefined : String(page - 1) })}>
            ← Page précédente
          </Link>
        )}
        <span className="muted">
          Page {page} / {totalPages}
        </span>
        {page < totalPages && (
          <Link href={buildQuery(queryBase, { page: String(page + 1) })}>Page suivante →</Link>
        )}
      </nav>
    </main>
  );
}
