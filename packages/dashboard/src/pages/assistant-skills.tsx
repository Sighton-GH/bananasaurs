import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import {
  ASSISTANT_URL,
  behaviourUrl,
  skillGrantUrl,
  type AssistantBehaviourView,
  type AssistantData,
  type SkillGrant,
} from '../api/assistant.js';
import { useSession, type Session } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { EmptyState } from '../ui/EmptyState.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';
import {
  behaviourBody,
  MemberChecklist,
  RoleChecklist,
  skillEffectLabel,
  toggleIn,
} from './assistant-shared.js';

/**
 * One behaviour's skill allowlist - the ONLY place allowlists are edited
 * (ADR 0060). Writes the whole behaviour object with everything else
 * preserved, so an allowlist save can never clobber a prompt edit.
 */
function BehaviourAllowlistEditor({
  behaviour,
  data,
  session,
  onSaved,
}: {
  readonly behaviour: AssistantBehaviourView;
  readonly data: AssistantData;
  readonly session: Session;
  readonly onSaved: () => void;
}) {
  const toast = useToast();
  const [allowedSkillIds, setAllowedSkillIds] = useState<readonly string[]>(
    behaviour.allowedSkillIds,
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const result = await session.write(
        behaviourUrl(behaviour.id),
        behaviourBody(behaviour, { allowedSkillIds }),
        'PUT',
      );
      if (result !== undefined) {
        toast({ tone: 'ok', title: `${behaviour.name} allowlist saved` });
        onSaved();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label={`Allowlist for ${behaviour.name}`}
      className="border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0"
    >
      <h3 className="text-sm font-medium">
        {behaviour.name}{' '}
        <span className="font-normal text-ink-muted">
          ({behaviour.surface === 'direct-command' ? 'direct command' : `@${behaviour.surface}`})
        </span>
      </h3>
      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {data.skills.map((skill) => (
          <li key={skill.id}>
            <label className="flex items-start gap-2 rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm">
              <input
                type="checkbox"
                checked={allowedSkillIds.includes(skill.id)}
                onChange={() => setAllowedSkillIds((ids) => toggleIn(ids, skill.id))}
              />
              <span>
                <span className="block">{skill.name}</span>
                <span className="text-xs text-ink-muted">{skillEffectLabel(skill)}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {allowedSkillIds.length === 0 && (
        <p role="status" className="mt-2 text-xs text-hold">
          Nothing is allowed: this behaviour can answer from its instructions and reviewed sources,
          but cannot do anything.
        </p>
      )}
      <div className="mt-2">
        <Button
          busy={busy}
          disabled={allowedSkillIds.join('|') === behaviour.allowedSkillIds.join('|')}
          onClick={() => void save()}
        >
          Save allowlist
        </Button>
      </div>
    </section>
  );
}

/**
 * One line saying who may use a skill: role names from the live directory,
 * never raw ids. A missing role means it left the server since the grant
 * was saved.
 */
function grantSummary(grant: SkillGrant | undefined, roles: AssistantData['roles']): string {
  const roleIds = grant?.roleIds ?? [];
  const userIds = grant?.userIds ?? [];
  if (roleIds.length === 0 && userIds.length === 0) return 'Nobody yet';
  const names = roleIds.map(
    (id) => roles?.find((role) => role.id === id)?.name ?? 'a role that no longer exists',
  );
  const people =
    userIds.length === 0
      ? ''
      : `${String(userIds.length)} ${userIds.length === 1 ? 'person' : 'people'}`;
  if (names.length === 0) return people;
  if (people === '') return names.join(', ');
  return `${names.join(', ')} and ${people}`;
}

/**
 * The grant editor for one skill: role and member checklists saved with the
 * same PUT body the full editor always used. Rendered only for the one
 * expanded row so the grants card stays a compact list on small screens.
 */
function SkillGrantEditor({
  skill,
  grant,
  roles,
  members,
  session,
  onSaved,
  onClose,
}: {
  readonly skill: AssistantData['skills'][number];
  readonly grant: SkillGrant | undefined;
  readonly roles: AssistantData['roles'];
  readonly members: AssistantData['members'];
  readonly session: Session;
  readonly onSaved: () => void;
  readonly onClose: () => void;
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
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={`Who can use ${skill.name}`} className="mt-3 border-t border-line pt-3">
      <div className="grid gap-3 md:grid-cols-2">
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
        Nobody can use this skill until you choose who can.
      </p>
      <div className="mt-2">
        <Button busy={busy} onClick={() => void save()}>
          Save grant
        </Button>
      </div>
    </section>
  );
}

/**
 * Guild-wide skill grants as a compact list: one row per skill with a
 * one-line summary, expanding at most one editor at a time. Owner-only
 * skills have no grant to edit and render their standing restriction.
 */
function SkillGrantList({
  data,
  session,
  onSaved,
}: {
  readonly data: AssistantData;
  readonly session: Session;
  readonly onSaved: () => void;
}) {
  const [expandedId, setExpandedId] = useState<string>();
  return (
    <ul className="grid gap-3">
      {data.skills.map((skill) => {
        const grant = data.skillGrants?.find((g) => g.skillId === skill.id);
        const expanded = expandedId === skill.id;
        return (
          <li key={skill.id} className="rounded-md border border-line bg-canvas p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{skill.name}</p>
                {skill.ownerOnly === true ? (
                  <p className="mt-1 text-xs text-ink-muted">
                    Always restricted to the server owner; no grant can widen it.
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-ink-muted">{grantSummary(grant, data.roles)}</p>
                )}
              </div>
              {skill.ownerOnly !== true && (
                <Button
                  className="shrink-0"
                  onClick={() => setExpandedId(expanded ? undefined : skill.id)}
                >
                  Change who can use it
                </Button>
              )}
            </div>
            {expanded && skill.ownerOnly !== true && (
              <SkillGrantEditor
                key={skill.id}
                skill={skill}
                grant={grant}
                roles={data.roles}
                members={data.members}
                session={session}
                onSaved={onSaved}
                onClose={() => setExpandedId(undefined)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * `/assistant/skills`: the skill catalogue with confirmation classes, the
 * per-behaviour allowlists, guild-wide grants and a link to Assistant
 * history for recent activity (ADR 0060).
 */
export function AssistantSkillsPage() {
  const session = useSession();
  const load = useCallback(() => session.read<AssistantData>(ASSISTANT_URL), [session]);
  const assistant = useResource('assistant skills', load);
  return (
    <>
      <PageHeader
        title="Skills"
        purpose="Everything the assistant can do in this server, which behaviours may use each skill, and who may use them at all."
        actions={
          <Link href="/assistant/activity">
            <Button>Assistant history</Button>
          </Link>
        }
      />
      <DataState
        resource={assistant.resource}
        isEmpty={(data) => data.skills.length === 0}
        empty={
          <EmptyState
            title="No skills reported"
            detail="This server build did not report a skill catalogue. Nothing here is editable and the assistant's current policy keeps applying."
          />
        }
      >
        {(data) => (
          <div className="space-y-5">
            <Card title="Skill catalogue">
              <p className="mb-3 text-sm text-ink-muted">
                Every skill the assistant could use in this server. Members never see this list; it
                is narrowed twice before anything runs - by the behaviour's allowlist below and by
                the grants at the bottom of this page.
              </p>
              <ul className="grid gap-3 md:grid-cols-2">
                {data.skills.map((skill) => (
                  <li key={skill.id} className="rounded-md border border-line bg-canvas p-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium">{skill.name}</p>
                      <span className="flex shrink-0 gap-1">
                        {skill.ownerOnly === true && <Badge tone="neutral">owner only</Badge>}
                        <Badge tone={skill.requiresConfirmation ? 'hold' : 'ok'}>
                          {skill.requiresConfirmation ? 'You confirm first' : 'Runs without asking'}
                        </Badge>
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">{skill.description}</p>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Allowlists per behaviour">
              <p className="mb-1 text-sm text-ink-muted">
                For each behaviour, choose the skills it may use. The model only sees the skills
                allowed here, and members also need to be allowed below.
              </p>
              {data.behaviours.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  No behaviours configured yet. Create one on the{' '}
                  <Link className="underline" href="/assistant">
                    Assistant page
                  </Link>
                  .
                </p>
              ) : (
                data.behaviours.map((behaviour) => (
                  <BehaviourAllowlistEditor
                    key={behaviour.id}
                    behaviour={behaviour}
                    data={data}
                    session={session}
                    onSaved={assistant.reload}
                  />
                ))
              )}
            </Card>
            <Card title="Skill grants">
              <p className="mb-3 text-sm text-ink-muted">
                Who may use each skill anywhere in this server. Reminders, memory and decisions stay
                with the owner until you allow someone here.
              </p>
              {data.skillGrants === undefined ? (
                <p className="text-xs text-ink-muted">
                  Skill grants are not exposed by this server build yet; the server's current policy
                  keeps applying and nothing here can be edited.
                </p>
              ) : (
                <SkillGrantList data={data} session={session} onSaved={assistant.reload} />
              )}
            </Card>
            <p className="text-sm text-ink-muted">
              Recent runs, with what the assistant did and how each turn ended, are on{' '}
              <Link className="underline" href="/assistant/activity">
                Assistant history
              </Link>
              .
            </p>
          </div>
        )}
      </DataState>
    </>
  );
}
