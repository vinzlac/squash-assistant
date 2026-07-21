import type { BookingRule } from "@squash-assistant/db/schema";
import { upsertRuleAction } from "../actions";

interface RuleFormProps {
  rule?: BookingRule;
  /** Pré-remplit et verrouille le groupe WhatsApp en création — la règle est toujours créée depuis la page d'un groupe. */
  whatsappGroupJid?: string;
  /** Libellé lisible du groupe WhatsApp (huddle-bot `list_groups`), affiché à côté du JID si résolu. */
  whatsappGroupName?: string;
  /** Libellé lisible du groupe resa-squash (`list_my_groups`), affiché à côté du groupId si résolu. */
  resaSquashGroupName?: string;
  /** userId resa-squash → "Prénom Nom" (`list_group_members`), pour afficher les noms des réservataires prioritaires. */
  groupMemberNames?: Record<string, string>;
}

export function RuleForm({
  rule,
  whatsappGroupJid,
  whatsappGroupName,
  resaSquashGroupName,
  groupMemberNames,
}: RuleFormProps) {
  const isNew = !rule;
  const groupJid = rule?.whatsappGroupJid ?? whatsappGroupJid ?? "";

  return (
    <form action={upsertRuleAction}>
      <input type="hidden" name="isNew" value={isNew.toString()} />
      <input type="hidden" name="whatsappGroupJid" value={groupJid} />

      <div className="form-grid">
        <label>
          ID de la règle
          <input type="text" name="id" defaultValue={rule?.id} required readOnly={!isNew} />
        </label>
        <label>
          Groupe WhatsApp (JID){whatsappGroupName ? ` — ${whatsappGroupName}` : ""}
          <input type="text" value={groupJid} readOnly />
        </label>
        <label>
          Groupe resa-squash (ID){resaSquashGroupName ? ` — ${resaSquashGroupName}` : ""}
          <input type="text" name="resaSquashGroupId" defaultValue={rule?.resaSquashGroupId} required />
        </label>
        <label>
          Heures candidates (séparées par virgules)
          <input
            type="text"
            name="candidateStartTimes"
            defaultValue={rule?.candidateStartTimes.join(", ")}
            placeholder="18H45, 19H30"
            required
          />
        </label>
        <label>
          Cron sondage
          <input type="text" name="pollCron" defaultValue={rule?.pollCron} placeholder="0 10 * * 2" required />
        </label>
        <label>
          Cron décision
          <input type="text" name="decisionCron" defaultValue={rule?.decisionCron} placeholder="30 21 * * 2" required />
        </label>
        <label>
          Décalage jour cible
          <input type="number" name="targetWeekdayOffset" defaultValue={rule?.targetWeekdayOffset ?? 7} required />
        </label>
        <label>
          Max réservations / joueur
          <input
            type="number"
            name="maxReservationsPerPlayer"
            defaultValue={rule?.maxReservationsPerPlayer ?? 2}
            required
          />
        </label>
        <label>
          Max terrains / créneau
          <input type="number" name="maxCourtsPerSlot" defaultValue={rule?.maxCourtsPerSlot ?? 3} required />
        </label>
        <label>
          Min joueurs / court
          <input type="number" name="minPlayersPerCourt" defaultValue={rule?.minPlayersPerCourt ?? 2} required />
        </label>
        <label>
          Max joueurs / court
          <input type="number" name="maxPlayersPerCourt" defaultValue={rule?.maxPlayersPerCourt ?? 3} required />
        </label>
        <label>
          Réservataires prioritaires (userIds, séparés par virgules)
          <input type="text" name="priorityBookers" defaultValue={rule?.priorityBookers.join(", ")} />
        </label>
        {rule && rule.priorityBookers.length > 0 && (
          <table style={{ gridColumn: "1 / -1" }}>
            <thead>
              <tr>
                <th>userId réservataire prioritaire</th>
                <th>Nom</th>
              </tr>
            </thead>
            <tbody>
              {rule.priorityBookers.map((userId) => (
                <tr key={userId}>
                  <td className="muted">{userId}</td>
                  <td>{groupMemberNames?.[userId] ?? "?"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <label>
          Priorité des courts (numéros, séparés par virgules)
          <input type="text" name="courtPriority" defaultValue={rule?.courtPriority.join(", ")} placeholder="4, 3, 2, 1" />
        </label>
        <label>
          <input
            type="checkbox"
            name="preferMinPlayersPerCourt"
            defaultChecked={rule?.preferMinPlayersPerCourt ?? true}
          />{" "}
          Préférer le nombre min de joueurs par court
        </label>
      </div>

      <div className="form-actions">
        <button type="submit" className="button-primary">
          {isNew ? "Créer" : "Enregistrer"}
        </button>
      </div>
    </form>
  );
}
