import Link from "next/link";
import { isAdmin } from "../../lib/authz";
import { formatDateTimeParis } from "../../lib/datetime";
import { listHuddleBotGroups } from "../../lib/huddleBot";
import {
  countResaEvents,
  getRelaySettings,
  listBookingRuleResaGroupIds,
  listDistinctEventActors,
  listResaEvents,
  type ListResaEventsFilter,
  type ListenerActorOption,
  type ResaEventsSort,
} from "../../lib/listenerAdmin";
import { listResaSquashMembersForGroups } from "../../lib/resaSquash";
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

function mergeActorOptions(...lists: ListenerActorOption[][]): ListenerActorOption[] {
  const byValue = new Map<string, ListenerActorOption>();
  for (const list of lists) {
    for (const opt of list) {
      if (!byValue.has(opt.value)) byValue.set(opt.value, opt);
    }
  }
  return [...byValue.values()].sort((a, b) => a.label.localeCompare(b.label, "fr"));
}

async function loadActorOptions(): Promise<ListenerActorOption[]> {
  const [fromEvents, groupIds] = await Promise.all([
    listDistinctEventActors(),
    listBookingRuleResaGroupIds(),
  ]);

  let fromResa: ListenerActorOption[] = [];
  try {
    const members = await listResaSquashMembersForGroups(groupIds);
    const byPhone = new Map<string, ListenerActorOption>();
    for (const m of members) {
      const name = `${m.first_name} ${m.last_name}`.trim();
      const phone = m.phone?.trim();
      if (phone) {
        if (!byPhone.has(phone)) {
          byPhone.set(phone, { value: phone, label: name ? `${name} (${phone})` : phone });
        }
      } else if (name) {
        // Rare sans téléphone — filtre par nom.
        byPhone.set(`name:${name}`, { value: name, label: name });
      }
    }
    fromResa = [...byPhone.values()];
  } catch {
    fromResa = [];
  }

  return mergeActorOptions(fromResa, fromEvents);
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
    groupJid: sp.group || undefined,
    actor: sp.actor || undefined,
    occurredFrom: sp.from || undefined,
    occurredTo: sp.to || undefined,
  };
  const offset = (page - 1) * PAGE_SIZE;

  const queryBase: Record<string, string | undefined> = {
    sort: sort === "asc" ? "asc" : undefined,
    type: sp.type,
    group: sp.group,
    actor: sp.actor,
    from: sp.from,
    to: sp.to,
  };

  const [settings, events, total, whatsappGroups, actors] = await Promise.all([
    getRelaySettings(),
    listResaEvents({ ...filter, limit: PAGE_SIZE, offset, sort }),
    countResaEvents(filter),
    listHuddleBotGroups().catch(() => null),
    loadActorOptions(),
  ]);

  const groupOptions = (whatsappGroups ?? [])
    .filter((g) => g.isGroup)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));

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
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
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
            <select name="group" defaultValue={sp.group ?? ""}>
              <option value="">Tous</option>
              {groupOptions.map((g) => (
                <option key={g.jid} value={g.jid}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
            Acteur
            <select name="actor" defaultValue={sp.actor ?? ""}>
              <option value="">Tous</option>
              {actors.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {whatsappGroups === null && (
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            huddle-bot indisponible — liste des groupes non préremplie.
          </p>
        )}
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
