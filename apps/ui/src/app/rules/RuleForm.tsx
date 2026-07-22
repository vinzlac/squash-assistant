import type { BookingRule } from "@squash-assistant/db/schema";
import { upsertRuleAction } from "../actions";
import { RuleGeneratorPanel } from "../components/RuleGeneratorPanel";

interface RuleFormProps {
  rule?: BookingRule;
  /** Pré-remplit tous les champs (sauf id/enabled) depuis une règle existante — duplication (bouton "Dupliquer"). */
  cloneFromRule?: BookingRule;
  /** Pré-remplit et verrouille le groupe WhatsApp en création — la règle est toujours créée depuis la page d'un groupe. */
  whatsappGroupJid?: string;
  /** Libellé lisible du groupe WhatsApp (huddle-bot `list_groups`), affiché à côté du JID si résolu. */
  whatsappGroupName?: string;
  /** Libellé lisible du groupe resa-squash (`list_my_groups`), affiché à côté du groupId si résolu. */
  resaSquashGroupName?: string;
  /** userId resa-squash → "Prénom Nom" (`list_group_members`), pour afficher les noms des réservataires prioritaires. */
  groupMemberNames?: Record<string, string>;
  /** Timestamps bruts de la ligne DB (pas dans BookingRule, cf. schema.ts) — affichage informatif seulement. */
  createdAt?: Date;
  updatedAt?: Date;
}

export function RuleForm({
  rule,
  cloneFromRule,
  whatsappGroupJid,
  whatsappGroupName,
  resaSquashGroupName,
  groupMemberNames,
  createdAt,
  updatedAt,
}: RuleFormProps) {
  const isNew = !rule;
  // `source` fournit les valeurs par défaut de tous les champs sauf id/enabled :
  // en édition c'est la règle elle-même, en duplication c'est la règle source à copier.
  const source = rule ?? cloneFromRule;
  const groupJid = rule?.whatsappGroupJid ?? whatsappGroupJid ?? "";
  const defaultName = cloneFromRule ? `${cloneFromRule.name ?? cloneFromRule.id} (copie)` : (rule?.name ?? "");

  return (
    <form action={upsertRuleAction}>
      <input type="hidden" name="isNew" value={isNew.toString()} />
      <input type="hidden" name="whatsappGroupJid" value={groupJid} />

      <RuleGeneratorPanel enabled={rule?.enabled ?? false} />

      <div className="form-grid">
        <label>
          ID de la règle
          <input type="text" name="id" defaultValue={rule?.id} required readOnly={!isNew} />
        </label>
        <label>
          Nom (affiché dans l'UI, l'id reste le slug technique)
          <input type="text" name="name" defaultValue={defaultName} placeholder="ex. Squashacadémie — mardi" />
        </label>
        <label>
          Groupe WhatsApp (JID){whatsappGroupName ? ` — ${whatsappGroupName}` : ""}
          <input type="text" value={groupJid} readOnly />
        </label>
        <label>
          Groupe resa-squash (ID){resaSquashGroupName ? ` — ${resaSquashGroupName}` : ""}
          <input type="text" name="resaSquashGroupId" defaultValue={source?.resaSquashGroupId} required />
        </label>
        <label>
          Heures candidates (séparées par virgules)
          <input
            type="text"
            name="candidateStartTimes"
            defaultValue={source?.candidateStartTimes.join(", ")}
            placeholder="18H45, 19H30"
            required
          />
        </label>
        <label>
          Cron sondage
          <input type="text" name="pollCron" defaultValue={source?.pollCron} placeholder="0 10 * * 2" required />
        </label>
        <label>
          Cron décision
          <input type="text" name="decisionCron" defaultValue={source?.decisionCron} placeholder="30 21 * * 2" required />
        </label>
        <label>
          Décalage jour cible
          <input type="number" name="targetWeekdayOffset" defaultValue={source?.targetWeekdayOffset ?? 7} required />
        </label>
        <label>
          Max réservations / joueur
          <input
            type="number"
            name="maxReservationsPerPlayer"
            defaultValue={source?.maxReservationsPerPlayer ?? 2}
            required
          />
        </label>
        <label>
          Max terrains / créneau
          <input type="number" name="maxCourtsPerSlot" defaultValue={source?.maxCourtsPerSlot ?? 3} required />
        </label>
        <label>
          Min joueurs / court
          <input type="number" name="minPlayersPerCourt" defaultValue={source?.minPlayersPerCourt ?? 2} required />
        </label>
        <label>
          Max joueurs / court
          <input type="number" name="maxPlayersPerCourt" defaultValue={source?.maxPlayersPerCourt ?? 3} required />
        </label>
        <label>
          Réservataires prioritaires (userIds, séparés par virgules)
          <input type="text" name="priorityBookers" defaultValue={source?.priorityBookers.join(", ")} />
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
          <input type="text" name="courtPriority" defaultValue={source?.courtPriority.join(", ")} placeholder="4, 3, 2, 1" />
        </label>
        <label>
          <input
            type="checkbox"
            name="preferMinPlayersPerCourt"
            defaultChecked={source?.preferMinPlayersPerCourt ?? true}
          />{" "}
          Préférer le nombre min de joueurs par court
        </label>
        <label>
          Fenêtre de disponibilité (heures après la 1ère heure candidate)
          <input
            type="number"
            name="availabilityWindowHours"
            defaultValue={source?.availabilityWindowHours ?? 3}
            min={0}
            required
          />
        </label>
      </div>

      <div className="form-actions">
        <button type="submit" className="button-primary">
          {isNew ? "Créer" : "Enregistrer"}
        </button>
      </div>
      {(createdAt || updatedAt) && (
        <p className="muted" style={{ marginTop: "1rem", fontSize: "0.8rem" }}>
          {createdAt && <>Créée le {createdAt.toLocaleString("fr-FR")}</>}
          {createdAt && updatedAt && " — "}
          {updatedAt && <>Modifiée le {updatedAt.toLocaleString("fr-FR")}</>}
        </p>
      )}
    </form>
  );
}
