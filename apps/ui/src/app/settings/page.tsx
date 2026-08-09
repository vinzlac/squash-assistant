import Link from "next/link";
import { formatWholeDayParisLabel, listClubClosures } from "../../lib/clubClosures";
import { listHuddleBotGroups } from "../../lib/huddleBot";
import { getVisibleWhatsappGroupJids } from "../../lib/settings";
import {
  addClubClosureAction,
  deleteClubClosureAction,
  saveVisibleGroupsAction,
} from "../actions";
import { isAdmin } from "../../lib/authz";
import { ClubClosureAddForm } from "../components/ClubClosureAddForm";
import { SubmitButton } from "../components/SubmitButton";

export const dynamic = "force-dynamic";

function formatParis(date: Date): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function formatClosureCell(startsAt: Date, endsAt: Date): { start: string; end: string } {
  const whole = formatWholeDayParisLabel(startsAt, endsAt);
  if (whole) {
    return { start: whole, end: "—" };
  }
  return { start: formatParis(startsAt), end: formatParis(endsAt) };
}

export default async function SettingsPage() {
  const [groups, visibleJids, admin, closures] = await Promise.all([
    listHuddleBotGroups().catch(() => null),
    getVisibleWhatsappGroupJids(),
    isAdmin(),
    listClubClosures(),
  ]);

  return (
    <main>
      <p>
        <Link href="/">← Retour</Link>
      </p>
      <h1>Paramètres</h1>

      <h2>Groupes WhatsApp affichés sur l'accueil</h2>
      <p className="muted">
        Liste récupérée en direct depuis huddle-bot à l'ouverture de cette page. Décoche les groupes à masquer sur
        la page d'accueil — les règles existantes restent actives, seul l'affichage change.
      </p>

      {!admin && <p className="muted">Lecture seule — réservé aux administrateurs (groupe Authentik "squash-admins").</p>}
      {groups === null ? (
        <p className="muted">huddle-bot indisponible — impossible de lister les groupes WhatsApp pour l'instant.</p>
      ) : (
        <form action={saveVisibleGroupsAction}>
          <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0 }}>
            {groups
              .filter((g) => g.isGroup)
              .map((g) => (
                <label key={g.jid} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.35rem 0" }}>
                  <input
                    type="checkbox"
                    name="groupJids"
                    value={g.jid}
                    defaultChecked={visibleJids === null || visibleJids.includes(g.jid)}
                  />
                  {g.name}
                  <span className="muted">{g.jid}</span>
                </label>
              ))}
            {admin && (
              <div className="form-actions">
                <SubmitButton className="button-primary">Enregistrer</SubmitButton>
              </div>
            )}
          </fieldset>
        </form>
      )}

      <h2>Fermetures PUC</h2>
      <p className="muted">
        Intervalles pendant lesquels aucun créneau de squash ne doit être proposé.
      </p>

      {closures.length === 0 ? (
        <p className="muted">Aucune fermeture configurée.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Début</th>
                <th>Fin</th>
                <th>Libellé</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {closures.map((closure) => {
                const range = formatClosureCell(closure.startsAt, closure.endsAt);
                return (
                  <tr key={closure.id}>
                    <td>{range.start}</td>
                    <td>{range.end}</td>
                    <td>{closure.label ?? "—"}</td>
                    <td>
                      <form action={deleteClubClosureAction} className="inline">
                        <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0 }}>
                          <input type="hidden" name="id" value={closure.id} />
                          <SubmitButton>Supprimer</SubmitButton>
                        </fieldset>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ClubClosureAddForm action={addClubClosureAction} disabled={!admin} />
    </main>
  );
}
