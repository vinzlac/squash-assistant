import Link from "next/link";
import { listHuddleBotGroups } from "../../lib/huddleBot";
import { getVisibleWhatsappGroupJids } from "../../lib/settings";
import { saveVisibleGroupsAction } from "../actions";
import { SubmitButton } from "../components/SubmitButton";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [groups, visibleJids] = await Promise.all([
    listHuddleBotGroups().catch(() => null),
    getVisibleWhatsappGroupJids(),
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

      {groups === null ? (
        <p className="muted">huddle-bot indisponible — impossible de lister les groupes WhatsApp pour l'instant.</p>
      ) : (
        <form action={saveVisibleGroupsAction}>
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
          <div className="form-actions">
            <SubmitButton className="button-primary">Enregistrer</SubmitButton>
          </div>
        </form>
      )}
    </main>
  );
}
