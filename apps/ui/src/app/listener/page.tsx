import Link from "next/link";
import { isAdmin } from "../../lib/authz";
import { formatDateTimeParis } from "../../lib/datetime";
import { getRelaySettings, listResaEvents } from "../../lib/listenerAdmin";
import { updateListenerRelaySettingsAction } from "../actions";
import { SubmitButton } from "../components/SubmitButton";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

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

export default async function ListenerPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
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

  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [settings, events] = await Promise.all([
    getRelaySettings(),
    listResaEvents({ limit: PAGE_SIZE, offset }),
  ]);

  return (
    <main>
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
        Page {page} — {events.length} événement(s) affiché(s) (max {PAGE_SIZE} par page).
      </p>

      <div className="table-scroll" style={{ marginTop: "1rem" }}>
        <table>
          <thead>
            <tr>
              <th>Date</th>
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
                <td>{event.summary}</td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Aucun événement pour l&apos;instant.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <nav style={{ display: "flex", gap: "1rem", marginTop: "1rem" }}>
        {page > 1 && (
          <Link href={page === 2 ? "/listener" : `/listener?page=${page - 1}`}>← Page précédente</Link>
        )}
        {events.length === PAGE_SIZE && <Link href={`/listener?page=${page + 1}`}>Page suivante →</Link>}
      </nav>
    </main>
  );
}
