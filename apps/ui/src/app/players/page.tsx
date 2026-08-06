import Link from "next/link";
import { bookingRules } from "@squash-assistant/db/schema";
import { isAdmin } from "../../lib/authz";
import { getDb } from "../../lib/db";
import {
  getPlaySlotsDefaults,
  listPlayerPreferences,
} from "../../lib/playerPreferences";
import { listResaSquashMembersForGroups } from "../../lib/resaSquash";
import { SubmitButton } from "../components/SubmitButton";
import {
  deletePlayerPreferenceAction,
  savePlaySlotsDefaultsAction,
  upsertPlayerPreferenceAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function PlayersPage() {
  const [admin, defaults, prefs, rules] = await Promise.all([
    isAdmin(),
    getPlaySlotsDefaults(),
    listPlayerPreferences(),
    getDb().select({ groupId: bookingRules.resaSquashGroupId }).from(bookingRules),
  ]);

  const groupIds = [...new Set(rules.map((r) => r.groupId).filter(Boolean))];
  const members = await listResaSquashMembersForGroups(groupIds).catch(() => null);
  const prefsByUser = new Map(prefs.map((p) => [p.userId, p]));

  const uniqueMembers = new Map<string, { userId: string; name: string }>();
  for (const m of members ?? []) {
    if (uniqueMembers.has(m.user_id)) continue;
    uniqueMembers.set(m.user_id, {
      userId: m.user_id,
      name: `${m.first_name} ${m.last_name}`.trim() || m.user_id,
    });
  }
  // Inclure les overrides orphelins (plus dans aucun groupe).
  for (const p of prefs) {
    if (!uniqueMembers.has(p.userId)) {
      uniqueMembers.set(p.userId, {
        userId: p.userId,
        name: p.displayName?.trim() || p.userId,
      });
    }
  }
  const rows = [...uniqueMembers.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));

  return (
    <main>
      <p>
        <Link href="/">← Retour</Link>
      </p>
      <h1>Préférences joueurs</h1>
      <p className="muted">
        Temps de jeu <strong>effectif</strong> (créneaux de 45 min). Le plafond TeamR reste celui de chaque
        règle (<code>maxDailyReservationsPerPlayer</code>).
      </p>

      {!admin && <p className="muted">Lecture seule — réservé aux administrateurs.</p>}

      <h2>Défauts globaux</h2>
      <form action={savePlaySlotsDefaultsAction}>
        <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem", marginRight: "1rem" }}>
            Min
            <input
              type="number"
              name="defaultMinPlaySlots"
              min={1}
              max={6}
              defaultValue={defaults.defaultMinPlaySlots}
              style={{ width: "4rem" }}
            />
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
            Max
            <input
              type="number"
              name="defaultMaxPlaySlots"
              min={1}
              max={6}
              defaultValue={defaults.defaultMaxPlaySlots}
              style={{ width: "4rem" }}
            />
          </label>
          {admin && (
            <div className="form-actions">
              <SubmitButton className="button-primary">Enregistrer les défauts</SubmitButton>
            </div>
          )}
        </fieldset>
      </form>

      <h2>Membres des groupes</h2>
      {members === null && (
        <p className="muted">resa-squash indisponible — liste des membres non chargée (overrides seuls ci-dessous).</p>
      )}
      {rows.length === 0 ? (
        <p className="muted">Aucun membre à afficher.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Joueur</th>
              <th>Min</th>
              <th>Max</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const pref = prefsByUser.get(row.userId);
              const minVal = pref?.minPlaySlots ?? defaults.defaultMinPlaySlots;
              const maxVal = pref?.maxPlaySlots ?? defaults.defaultMaxPlaySlots;
              const isOverride = Boolean(pref);
              return (
                <tr key={row.userId}>
                  <td>
                    {row.name}
                    <div className="muted" style={{ fontSize: "0.85rem" }}>
                      {row.userId}
                      {isOverride ? " · surcharge" : " · défaut"}
                    </div>
                  </td>
                  <td colSpan={3}>
                    <form
                      action={upsertPlayerPreferenceAction}
                      style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}
                    >
                      <input type="hidden" name="userId" value={row.userId} />
                      <input type="hidden" name="displayName" value={row.name} />
                      <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0, display: "contents" }}>
                        <input
                          type="number"
                          name="minPlaySlots"
                          min={1}
                          max={6}
                          defaultValue={minVal}
                          style={{ width: "4rem" }}
                        />
                        <input
                          type="number"
                          name="maxPlaySlots"
                          min={1}
                          max={6}
                          defaultValue={maxVal}
                          style={{ width: "4rem" }}
                        />
                        {admin && (
                          <>
                            <SubmitButton>Sauvegarder</SubmitButton>
                          </>
                        )}
                      </fieldset>
                    </form>
                    {admin && isOverride && (
                      <form action={deletePlayerPreferenceAction} style={{ display: "inline" }}>
                        <input type="hidden" name="userId" value={row.userId} />
                        <SubmitButton>Revenir au défaut</SubmitButton>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
