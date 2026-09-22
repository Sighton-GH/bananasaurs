import { useCallback, useState } from 'react';
import { Link } from 'wouter';
import {
  ASSISTANT_URL,
  behaviourUrl,
  type AssistantBehaviourView,
  type AssistantData,
} from '../api/assistant.js';
import { useSession, type Session } from '../app/session.js';
import { useResource } from '../hooks/useResource.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { Card } from '../ui/Card.js';
import { DataState } from '../ui/DataState.js';
import { EmptyState } from '../ui/EmptyState.js';
import { HelpTip } from '../ui/HelpTip.js';
import { PageHeader } from '../ui/PageHeader.js';
import { useToast } from '../ui/Toast.js';
import { behaviourBody, SkillGrantRow, toggleIn } from './assistant-shared.js';

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
                <span className="text-xs text-ink-muted">
                  {skill.effect}
                  {skill.requiresConfirmation ? ' · asks an operator first' : ''}
                </span>
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
 * `/assistant/skills`: the skill catalogue with required permissions and
 * confirmation classes, the per-behaviour allowlists, guild-wide grants and
 * a link to Assistant history for recent activity (ADR 0060).
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
                          {skill.requiresConfirmation
                            ? 'Asks an operator first'
                            : 'Can do automatically'}
                        </Badge>
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">{skill.description}</p>
                    <p className="mt-2 text-xs text-ink-muted">
                      Needs the Discord permission{' '}
                      <span className="font-mono">{skill.requiredPermission}</span>{' '}
                      <HelpTip label="required permission">
                        A Discord permission the member must already hold before this skill runs, on
                        top of every check above. The bot never grants permissions; it only checks
                        them.
                      </HelpTip>
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Allowlists per behaviour">
              <p className="mb-1 text-sm text-ink-muted">
                For each behaviour, choose the skills it may use. The model only sees the skills
                allowed here, narrowed further by grants and the member's own permissions.
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
                Who may use each skill anywhere in this server, before the member's own permissions
                are checked. Reminder creation stays with the owner until a grant says otherwise.
              </p>
              {data.skillGrants === undefined ? (
                <p className="text-xs text-ink-muted">
                  Skill grants are not exposed by this server build yet; the server's current policy
                  keeps applying and nothing here can be edited.
                </p>
              ) : (
                <ul className="grid gap-3">
                  {data.skills.map((skill) => (
                    <SkillGrantRow
                      key={skill.id}
                      skill={skill}
                      grant={data.skillGrants?.find((g) => g.skillId === skill.id)}
                      roles={data.roles}
                      members={data.members}
                      session={session}
                      onSaved={assistant.reload}
                    />
                  ))}
                </ul>
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
