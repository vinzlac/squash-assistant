import type { BookingRule } from "@squash-assistant/db/schema";
import { upsertRuleAction } from "../actions";
import { CronField } from "../components/CronField";
import { MemberPicker } from "../components/MemberPicker";
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
  /** Règle verrouillée (référencée par un scénario, cf. ruleHasScenarios) — affichage seul, aucune sauvegarde possible. */
  readOnly?: boolean;
  /** ID généré côté serveur (randomUUID) pour une nouvelle règle — l'utilisateur n'a pas à le choisir, juste à le voir (ex. distinguer des noms dupliqués). */
  generatedId?: string;
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
  readOnly = false,
  generatedId,
}: RuleFormProps) {
  const isNew = !rule;
  // `source` fournit les valeurs par défaut de tous les champs sauf id/enabled :
  // en édition c'est la règle elle-même, en duplication c'est la règle source à copier.
  const source = rule ?? cloneFromRule;
  const id = rule?.id ?? generatedId ?? "";
  const groupJid = rule?.whatsappGroupJid ?? whatsappGroupJid ?? "";
  const defaultName = cloneFromRule ? `${cloneFromRule.name ?? cloneFromRule.id} (copie)` : (rule?.name ?? "");
  // Le picker (nom + userId, liste vivante) remplace le champ texte CSV — gardé en repli
  // (masqué en hidden, jamais perdu) seulement quand les membres du groupe resa-squash sont
  // inconnus (erreur MCP, etc.), seul cas où on ne peut pas proposer de liste à choisir.
  const hasGroupMembers = Object.keys(groupMemberNames ?? {}).length > 0;

  return (
    <form action={upsertRuleAction}>
      <input type="hidden" name="isNew" value={isNew.toString()} />
      <input type="hidden" name="whatsappGroupJid" value={groupJid} />

      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
      <RuleGeneratorPanel enabled={rule?.enabled ?? false} />

      <div className="form-grid">
        <label>
          ID de la règle (généré automatiquement, non modifiable)
          <input type="text" name="id" value={id} required readOnly />
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
        <CronField name="pollCron" label="Cron sondage" defaultValue={source?.pollCron} placeholder="0 10 * * 2" />
        <CronField
          name="decisionCron"
          label="Cron décision"
          defaultValue={source?.decisionCron}
          placeholder="30 21 * * 2"
        />
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
        {hasGroupMembers ? (
          <input type="hidden" name="priorityBookers" defaultValue={source?.priorityBookers.join(", ")} />
        ) : (
          <label>
            Réservataires prioritaires (userIds, séparés par virgules)
            <input type="text" name="priorityBookers" defaultValue={source?.priorityBookers.join(", ")} />
          </label>
        )}
        {hasGroupMembers && (
          <label style={{ gridColumn: "1 / -1" }}>
            Réservataires prioritaires
            <MemberPicker
              groupMemberNames={groupMemberNames ?? {}}
              targetFieldName="priorityBookers"
              initialSelected={source?.priorityBookers ?? []}
            />
          </label>
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
        <label>
          Plafond de résas / joueur / jour (limite de courtoisie, pas TeamR)
          <input
            type="number"
            name="maxDailyReservationsPerPlayer"
            defaultValue={source?.maxDailyReservationsPerPlayer ?? 2}
            min={1}
            max={6}
            required
          />
        </label>
        <label>
          Marge joueurs imprévus (ex. 1 si souvent un joueur en plus se présente sans avoir voté)
          <input
            type="number"
            name="unexpectedPlayersMargin"
            defaultValue={source?.unexpectedPlayersMargin ?? 0}
            min={0}
            max={4}
            required
          />
        </label>
        {hasGroupMembers ? (
          <input type="hidden" name="substituteBookers" defaultValue={source?.substituteBookers.join(", ")} />
        ) : (
          <label>
            Prête-noms (userIds, séparés par virgules, par ordre de priorité)
            <input type="text" name="substituteBookers" defaultValue={source?.substituteBookers.join(", ")} />
          </label>
        )}
        {hasGroupMembers && (
          <label style={{ gridColumn: "1 / -1" }}>
            Prête-noms
            <MemberPicker
              groupMemberNames={groupMemberNames ?? {}}
              targetFieldName="substituteBookers"
              initialSelected={source?.substituteBookers ?? []}
            />
          </label>
        )}
      </div>

      {!readOnly && (
        <div className="form-actions">
          <button type="submit" className="button-primary">
            {isNew ? "Créer" : "Enregistrer"}
          </button>
        </div>
      )}
      </fieldset>
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
