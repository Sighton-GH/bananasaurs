import type { AssistantSkill, ReminderStatus } from '@bananasaurs/core';
import {
  type AssistantBehaviourView,
  type DecisionRow,
  type GuildMemberInfo,
  type GuildRoleInfo,
  type TicketRow,
} from '../api/assistant.js';

/**
 * Pieces the assistant purpose pages share (ADR 0060): the whole-object
 * behaviour write, the live-directory checklists, the grant editor and the
 * status tones. They live here so `/assistant`, `/assistant/skills`,
 * `/assistant/schedules` and `/assistant/resources` render the same control
 * the same way instead of drifting into copies.
 */

export const reminderTone = (status: ReminderStatus) =>
  status === 'failed'
    ? 'danger'
    : status === 'scheduled' || status === 'delivering'
      ? 'hold'
      : status === 'delivered'
        ? 'ok'
        : 'neutral';

export const ticketTone = (status: TicketRow['status']) =>
  status === 'resolved' ? 'ok' : status === 'claimed' ? 'neutral' : 'hold';

export const decisionTone = (status: DecisionRow['status']) =>
  status === 'saved' ? 'ok' : status === 'reviewed' ? 'neutral' : 'hold';

export const toggleIn = (list: readonly string[], id: string): readonly string[] =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

/** Plain words for what a skill does, shared by the create form and the behaviour editor. */
export const skillEffectLabel = (skill: AssistantSkill): string =>
  skill.effect === 'read'
    ? 'Reads'
    : skill.effect === 'draft'
      ? 'Drafts, never sends'
      : skill.effect === 'schedule'
        ? 'Schedules'
        : 'Sends';

/** Plain words for one skill's scope, shared by the skills list and the scope editor. */
export const scopeLabel = (
  scope: { readonly mode: 'everyone' | 'roles' | 'owner'; readonly roleIds: readonly string[] },
  roleName: (id: string) => string | undefined,
): string => {
  if (scope.mode === 'everyone') return 'Everyone who can ask';
  if (scope.mode === 'owner') return 'Owner only';
  return `Roles: ${scope.roleIds.map((id) => `@${roleName(id) ?? id}`).join(', ')}`;
};

/** The body PUT /api/assistant/behaviours/:id accepts: every stored field, whole. */
export const behaviourBody = (
  behaviour: AssistantBehaviourView,
  patch: Partial<{
    enabled: boolean;
    systemPrompt: string;
    callerRoleIds: readonly string[];
    resourceIds: readonly string[];
    preferredSkillIds: readonly string[];
    ticket: { readonly channelId?: string; readonly reviewerRoleIds?: readonly string[] };
  }>,
) => ({
  id: behaviour.id,
  surface: behaviour.surface,
  ...(behaviour.mentionRoleId === undefined ? {} : { mentionRoleId: behaviour.mentionRoleId }),
  name: behaviour.name,
  systemPrompt: patch.systemPrompt ?? behaviour.systemPrompt,
  promptVersion: behaviour.promptVersion,
  preferredSkillIds: patch.preferredSkillIds ?? behaviour.preferredSkillIds,
  resourceIds: patch.resourceIds ?? behaviour.resourceIds,
  enabled: patch.enabled ?? behaviour.enabled,
  ...(behaviour.callerRoleIds === undefined
    ? {}
    : { callerRoleIds: patch.callerRoleIds ?? behaviour.callerRoleIds }),
  ...(behaviour.ticket === undefined ? {} : { ticket: patch.ticket ?? behaviour.ticket }),
});

/** A live-directory checklist: the only way an identity enters a grant or allowlist. */
export function RoleChecklist({
  roles,
  selected,
  onToggle,
  label,
}: {
  readonly roles: readonly GuildRoleInfo[] | undefined;
  readonly selected: readonly string[];
  readonly onToggle: (id: string) => void;
  readonly label: string;
}) {
  if (roles === undefined) {
    return (
      <p className="mt-2 text-xs text-ink-muted">
        The role directory did not load, so this list cannot be edited. Nothing is changed.
      </p>
    );
  }
  if (roles.length === 0) {
    return <p className="mt-2 text-xs text-ink-muted">This server has no roles to offer.</p>;
  }
  return (
    <ul aria-label={label} className="mt-2 grid gap-1 sm:grid-cols-2">
      {[...roles]
        .sort((a, b) => b.position - a.position)
        .map((role) => (
          <li key={role.id}>
            <label className="flex items-center gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(role.id)}
                onChange={() => onToggle(role.id)}
              />
              <span className="min-w-0 truncate">{role.name}</span>
            </label>
          </li>
        ))}
    </ul>
  );
}

export function MemberChecklist({
  members,
  selected,
  onToggle,
  label,
}: {
  readonly members: readonly GuildMemberInfo[] | undefined;
  readonly selected: readonly string[];
  readonly onToggle: (id: string) => void;
  readonly label: string;
}) {
  if (members === undefined) {
    return (
      <p className="mt-2 text-xs text-ink-muted">
        The member directory did not load, so this list cannot be edited. Nothing is changed.
      </p>
    );
  }
  return (
    <ul aria-label={label} className="mt-2 grid gap-1 sm:grid-cols-2">
      {[...members]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((member) => (
          <li key={member.id}>
            <label className="flex items-center gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(member.id)}
                onChange={() => onToggle(member.id)}
              />
              <span className="min-w-0 truncate">{member.name}</span>
            </label>
          </li>
        ))}
    </ul>
  );
}
