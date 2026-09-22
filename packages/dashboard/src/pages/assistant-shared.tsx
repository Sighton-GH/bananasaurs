import { useState } from 'react';
import type { AssistantSkill, ReminderStatus } from '@bananasaurs/core';
import {
  skillGrantUrl,
  type AssistantBehaviourView,
  type DecisionRow,
  type GuildMemberInfo,
  type GuildRoleInfo,
  type SkillGrant,
  type TicketRow,
} from '../api/assistant.js';
import type { Session } from '../app/session.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { useToast } from '../ui/Toast.js';

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

/** The body PUT /api/assistant/behaviours/:id accepts: every stored field, whole. */
export const behaviourBody = (
  behaviour: AssistantBehaviourView,
  patch: Partial<{
    enabled: boolean;
    systemPrompt: string;
    callerRoleIds: readonly string[];
    resourceIds: readonly string[];
    allowedSkillIds: readonly string[];
    ticket: { readonly channelId?: string; readonly reviewerRoleIds?: readonly string[] };
  }>,
) => ({
  id: behaviour.id,
  surface: behaviour.surface,
  ...(behaviour.mentionRoleId === undefined ? {} : { mentionRoleId: behaviour.mentionRoleId }),
  name: behaviour.name,
  systemPrompt: patch.systemPrompt ?? behaviour.systemPrompt,
  promptVersion: behaviour.promptVersion,
  allowedSkillIds: patch.allowedSkillIds ?? behaviour.allowedSkillIds,
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

/** Guild-scoped grants: who may use each skill at all, before any per-member permission check. */
export function SkillGrantRow({
  skill,
  grant,
  roles,
  members,
  session,
  onSaved,
}: {
  readonly skill: AssistantSkill;
  readonly grant: SkillGrant | undefined;
  readonly roles: readonly GuildRoleInfo[] | undefined;
  readonly members: readonly GuildMemberInfo[] | undefined;
  readonly session: Session;
  readonly onSaved: () => void;
}) {
  const toast = useToast();
  const [roleIds, setRoleIds] = useState<readonly string[]>(grant?.roleIds ?? []);
  const [userIds, setUserIds] = useState<readonly string[]>(grant?.userIds ?? []);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const result = await session.write(skillGrantUrl(skill.id), { roleIds, userIds }, 'PUT');
      if (result !== undefined) {
        toast({ tone: 'ok', title: `${skill.name} grant saved` });
        onSaved();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-md border border-line bg-canvas p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{skill.name}</p>
          <p className="text-xs text-ink-muted">{skill.description}</p>
        </div>
        <span className="flex shrink-0 gap-1">
          {skill.ownerOnly === true && <Badge tone="neutral">owner only</Badge>}
          <Badge tone={skill.requiresConfirmation ? 'hold' : 'ok'}>
            {skill.requiresConfirmation ? 'Asks an operator first' : 'Can do automatically'}
          </Badge>
        </span>
      </div>
      {skill.ownerOnly === true ? (
        <p className="mt-2 text-xs text-ink-muted">
          Always restricted to the server owner; no grant can widen it.
        </p>
      ) : (
        <>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <div>
              <p className="text-xs text-ink-muted">Roles</p>
              <RoleChecklist
                label={`Roles granted ${skill.name}`}
                roles={roles}
                selected={roleIds}
                onToggle={(id) => setRoleIds((ids) => toggleIn(ids, id))}
              />
            </div>
            <div>
              <p className="text-xs text-ink-muted">Members</p>
              <MemberChecklist
                label={`Members granted ${skill.name}`}
                members={members}
                selected={userIds}
                onToggle={(id) => setUserIds((ids) => toggleIn(ids, id))}
              />
            </div>
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            A skill with no grants fails closed: nobody may use it.
          </p>
          <div className="mt-2">
            <Button busy={busy} onClick={() => void save()}>
              Save grant
            </Button>
          </div>
        </>
      )}
    </li>
  );
}
