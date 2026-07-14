import type { BookingRule } from "@squash-assistant/db/schema";
import { upsertRuleAction } from "../actions";

export function RuleForm({ rule }: { rule?: BookingRule }) {
  const isNew = !rule;

  return (
    <form action={upsertRuleAction}>
      <input type="hidden" name="isNew" value={isNew.toString()} />

      <div className="form-grid">
        <label>
          ID de la règle
          <input type="text" name="id" defaultValue={rule?.id} required readOnly={!isNew} />
        </label>
        <label>
          Groupe WhatsApp (JID)
          <input type="text" name="whatsappGroupJid" defaultValue={rule?.whatsappGroupJid} required />
        </label>
        <label>
          Groupe resa-squash (ID)
          <input type="text" name="resaSquashGroupId" defaultValue={rule?.resaSquashGroupId} required />
        </label>
        <label>
          Heure de session
          <input type="text" name="sessionStartTime" defaultValue={rule?.sessionStartTime} placeholder="18H45" required />
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
